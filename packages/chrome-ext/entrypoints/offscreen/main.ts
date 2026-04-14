/**
 * Offscreen worker — decodes Mithril snapshots off the SW thread.
 *
 * Lifecycle:
 *   1. SW calls `chrome.offscreen.createDocument({ url: "offscreen.html", ... })`.
 *   2. This script runs once on load, registers a BroadcastChannel listener,
 *      and posts a `{ tag: "ready" }` handshake.
 *   3. For each `{ tag: "decode-ledger-state", ... }` request, it runs the
 *      full decode + account extraction + IndexedDB write pipeline in its
 *      own process, streams progress back, and posts completion.
 *
 * The offscreen opens the SAME `gerolamino-chain-store` IndexedDB as the SW
 * (IDB supports multi-context connections in one origin). Writes made here
 * are visible to later SW reads via the standard IDB transaction model.
 *
 * Note: this page has no UI — it just runs JS logic.
 */
import { Effect, HashMap, Layer } from "effect";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import {
  extractLedgerView,
  extractNonces,
  extractSnapshotTip,
  PREPROD_CONFIG,
  SlotClock,
  SlotClockLive,
} from "consensus";
import { decodeExtLedgerState } from "ledger";
import { BlobStore, accountKey, stakeKey } from "storage";
import { encodeAccountValue } from "../background/account-encoder.ts";
import { BrowserStorageLayers } from "../background/storage-browser.ts";
import type {
  OffscreenComplete,
  OffscreenError,
  OffscreenProgress,
  OffscreenReady,
  OffscreenRequest,
  SerializedLedgerView,
} from "../background/offscreen-protocol.ts";
import { OFFSCREEN_CHANNEL } from "../background/offscreen-protocol.ts";

const channel = new BroadcastChannel(OFFSCREEN_CHANNEL);

const post = (msg: OffscreenProgress | OffscreenComplete | OffscreenError | OffscreenReady) => {
  channel.postMessage(msg);
};

// ---------------------------------------------------------------------------
// Serialization helpers (flatten HashMap → entries array)
// ---------------------------------------------------------------------------

const serializeLedgerView = (lv: {
  readonly epochNonce: Uint8Array;
  readonly poolVrfKeys: HashMap.HashMap<string, Uint8Array>;
  readonly poolStake: HashMap.HashMap<string, bigint>;
  readonly totalStake: bigint;
  readonly activeSlotsCoeff: number;
  readonly maxKesEvolutions: number;
}): SerializedLedgerView => ({
  epochNonce: lv.epochNonce,
  poolVrfKeys: Array.from(HashMap.entries(lv.poolVrfKeys)),
  poolStake: Array.from(HashMap.entries(lv.poolStake)),
  totalStake: lv.totalStake,
  activeSlotsCoeff: lv.activeSlotsCoeff,
  maxKesEvolutions: lv.maxKesEvolutions,
});

// ---------------------------------------------------------------------------
// Decode pipeline
// ---------------------------------------------------------------------------

const ACCOUNT_CHUNK = 5000;

const handleDecode = (requestId: string, payload: Uint8Array) =>
  Effect.gen(function* () {
    const store = yield* BlobStore;

    yield* Effect.log(`[offscreen] Decoding ExtLedgerState (${payload.length} bytes)...`);
    post({
      tag: "decode-progress",
      requestId,
      phase: "decoding-ledger-state",
      accountsWritten: 0,
      stakeEntriesWritten: 0,
    });

    const extState = yield* decodeExtLedgerState(payload);
    yield* Effect.log(
      `[offscreen] Decoded: era ${extState.currentEra}, epoch ${extState.newEpochState.epoch}, ` +
        `${extState.newEpochState.poolDistr.pools.size} pools`,
    );

    const lv = yield* extractLedgerView(extState);
    const nonces = extractNonces(extState);
    const tip = extractSnapshotTip(extState);

    // --- Accounts ---
    const accounts = extState.newEpochState.epochState.ledgerState.certState.dState.accounts;
    const totalAccounts = accounts.size;
    yield* Effect.log(`[offscreen] Writing ${totalAccounts} accounts (chunks of ${ACCOUNT_CHUNK})`);
    post({
      tag: "decode-progress",
      requestId,
      phase: "writing-accounts",
      accountsWritten: 0,
      totalAccounts,
      stakeEntriesWritten: 0,
    });

    const accountEntries: Array<{ readonly key: Uint8Array; readonly value: Uint8Array }> = [];
    for (const [credKeyStr, acct] of accounts) {
      const colonIdx = credKeyStr.indexOf(":");
      const hashHex = credKeyStr.slice(colonIdx + 1);
      accountEntries.push({
        key: accountKey(Uint8Array.fromHex(hashHex)),
        value: encodeAccountValue(acct),
      });
    }
    for (let i = 0; i < accountEntries.length; i += ACCOUNT_CHUNK) {
      const slice = accountEntries.slice(i, i + ACCOUNT_CHUNK);
      yield* store.putBatch(slice);
      const written = Math.min(i + slice.length, accountEntries.length);
      post({
        tag: "decode-progress",
        requestId,
        phase: "writing-accounts",
        accountsWritten: written,
        totalAccounts,
        stakeEntriesWritten: 0,
      });
    }
    yield* Effect.log(`[offscreen] Accounts written (${accountEntries.length})`);

    // --- Stake distribution ---
    const stakeEntries: Array<{ readonly key: Uint8Array; readonly value: Uint8Array }> = [];
    for (const [poolHashHex, stake] of HashMap.entries(lv.poolStake)) {
      const val = new Uint8Array(8);
      new DataView(val.buffer).setBigUint64(0, stake);
      stakeEntries.push({ key: stakeKey(Uint8Array.fromHex(poolHashHex)), value: val });
    }
    const totalStakeEntries = stakeEntries.length;
    yield* Effect.log(`[offscreen] Writing ${totalStakeEntries} stake entries`);
    post({
      tag: "decode-progress",
      requestId,
      phase: "writing-stake",
      accountsWritten: accountEntries.length,
      totalAccounts,
      stakeEntriesWritten: 0,
      totalStakeEntries,
    });
    if (stakeEntries.length > 0) {
      yield* store.putBatch(stakeEntries);
    }
    post({
      tag: "decode-progress",
      requestId,
      phase: "writing-stake",
      accountsWritten: accountEntries.length,
      totalAccounts,
      stakeEntriesWritten: totalStakeEntries,
      totalStakeEntries,
    });
    yield* Effect.log(`[offscreen] Stake entries written (${totalStakeEntries})`);

    post({
      tag: "decode-complete",
      requestId,
      ledgerView: serializeLedgerView(lv),
      nonces: {
        active: nonces.active,
        evolving: nonces.evolving,
        candidate: nonces.candidate,
        epoch: nonces.epoch,
      },
      tip,
      accountsWritten: accountEntries.length,
      stakeEntriesWritten: totalStakeEntries,
    });
  });

// ---------------------------------------------------------------------------
// Service layers (offscreen document runs in a window, so globalThis.indexedDB
// is available directly — no need for a worker scope fallback)
// ---------------------------------------------------------------------------

const indexedDbLayer = Layer.succeed(
  IndexedDb.IndexedDb,
  IndexedDb.make({
    indexedDB: globalThis.indexedDB,
    IDBKeyRange: globalThis.IDBKeyRange,
  }),
);

const slotClockLayer = Layer.effect(SlotClock, SlotClockLive(PREPROD_CONFIG));

const runtimeLayer = Layer.mergeAll(
  BrowserStorageLayers().pipe(Layer.provide(indexedDbLayer), Layer.orDie),
  slotClockLayer,
);

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

channel.addEventListener("message", (event) => {
  const msg = event.data as OffscreenRequest | undefined;
  if (!msg || typeof msg !== "object" || msg.tag !== "decode-ledger-state") return;

  handleDecode(msg.requestId, msg.payload)
    .pipe(
      Effect.provide(runtimeLayer),
      Effect.tapError((e) =>
        Effect.sync(() =>
          post({ tag: "decode-error", requestId: msg.requestId, message: String(e) }),
        ),
      ),
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          const message = defect instanceof Error ? defect.message : String(defect);
          post({ tag: "decode-error", requestId: msg.requestId, message });
        }),
      ),
      Effect.runFork,
    );
});

Effect.logInfo("[offscreen] Offscreen decode worker booted").pipe(Effect.runFork);
post({ tag: "ready" });
