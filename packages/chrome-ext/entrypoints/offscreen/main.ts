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
import { Effect, HashMap, Layer, Schema, Stream } from "effect";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import { extractLedgerView, extractNonces, extractSnapshotTip, SlotClockPreprod } from "consensus";
import { decodeExtLedgerState } from "ledger";
import { type BlobEntry, BlobStore, accountKey, stakeKey } from "storage";
import { encodeAccountValue } from "../background/account-encoder.ts";
import { BrowserStorageLayers } from "../background/storage-browser.ts";
import type {
  OffscreenComplete,
  OffscreenError,
  OffscreenProgress,
  OffscreenReady,
  SerializedLedgerView,
} from "../background/offscreen-protocol.ts";
import { OFFSCREEN_CHANNEL, OffscreenRequest } from "../background/offscreen-protocol.ts";

const isOffscreenRequest = Schema.is(OffscreenRequest);

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
  readonly maxHeaderSize: number;
  readonly maxBlockBodySize: number;
  readonly ocertCounters: HashMap.HashMap<string, number>;
}): SerializedLedgerView => ({
  epochNonce: lv.epochNonce,
  poolVrfKeys: Array.from(HashMap.entries(lv.poolVrfKeys)),
  poolStake: Array.from(HashMap.entries(lv.poolStake)),
  totalStake: lv.totalStake,
  activeSlotsCoeff: lv.activeSlotsCoeff,
  maxKesEvolutions: lv.maxKesEvolutions,
  maxHeaderSize: lv.maxHeaderSize,
  maxBlockBodySize: lv.maxBlockBodySize,
  ocertCounters: Array.from(HashMap.entries(lv.ocertCounters)),
});

// ---------------------------------------------------------------------------
// Decode pipeline
// ---------------------------------------------------------------------------

// 50 k-row IndexedDB transactions are well within Chromium's per-tx
// limits (~50 GB / ~250 k objects in practice on a single object store)
// and reduce the per-transaction overhead 10× vs. the previous 5 k. The
// transaction-overhead × N pattern dominated the offscreen-decode wall
// clock when contending with the SW's concurrent block-batch writes:
// the SW issued ~9 k 500-row block transactions while the offscreen
// issued ~800 5 k-row account transactions on the same IDB, so the
// scheduler interleaved them; bigger account batches cut that
// interleaving rate without raising peak memory meaningfully (50 k
// accounts × ~200 B encoded ≈ 10 MB peak per-batch, vs. the working set
// of 4 M accounts already in heap from the decode step). Bumped further
// to 100 k after the streaming-encode rewrite removed the 4 M-entry
// pre-materialised array — peak working set per chunk is now ~20 MB,
// not 1.5 GB.
const ACCOUNT_CHUNK = 100_000;

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
        `${HashMap.size(extState.newEpochState.poolDistr.pools)} pools`,
    );

    const lv = yield* extractLedgerView(extState);
    const nonces = extractNonces(extState);
    const tip = extractSnapshotTip(extState);

    // --- Accounts ---
    //
    // Streaming pipeline replaces the old `materialise → 4 M-entry Array
    // → slice loop`. The previous shape allocated ~1.5 GB of `BlobEntry`
    // objects up front before the first IDB write started, which (a)
    // delayed the IDB-write phase by the full encode wall-clock and
    // (b) competed with the SW's concurrent block writes for heap +
    // GC time. Now we lazily pull `(credential, acct)` pairs out of
    // the HashMap, encode each into a `BlobEntry`, batch them in
    // `ACCOUNT_CHUNK`-sized groups, and `putBatch` per group — peak
    // working set is one chunk (~20 MB), not the full account set,
    // and IDB writes start within microseconds of the first encode.
    const accounts = extState.newEpochState.epochState.ledgerState.certState.dState.accounts;
    const totalAccounts = HashMap.size(accounts);
    yield* Effect.log(`[offscreen] Writing ${totalAccounts} accounts (chunks of ${ACCOUNT_CHUNK})`);
    post({
      tag: "decode-progress",
      requestId,
      phase: "writing-accounts",
      accountsWritten: 0,
      totalAccounts,
      stakeEntriesWritten: 0,
    });

    let accountsWritten = 0;
    yield* Stream.fromIterable(HashMap.entries(accounts)).pipe(
      Stream.map(
        ([credential, acct]): BlobEntry => ({
          key: accountKey(credential.hash),
          value: encodeAccountValue(acct),
        }),
      ),
      Stream.grouped(ACCOUNT_CHUNK),
      Stream.mapEffect(
        (chunk) =>
          Effect.gen(function* () {
            const slice = Array.from(chunk);
            yield* store.putBatch(slice);
            accountsWritten += slice.length;
            post({
              tag: "decode-progress",
              requestId,
              phase: "writing-accounts",
              accountsWritten,
              totalAccounts,
              stakeEntriesWritten: 0,
            });
          }),
        { concurrency: 1 },
      ),
      Stream.runDrain,
    );
    yield* Effect.log(`[offscreen] Accounts written (${accountsWritten})`);

    // --- Stake distribution ---
    const stakeEntries: Array<BlobEntry> = [];
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
      accountsWritten: accountsWritten,
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
      accountsWritten: accountsWritten,
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
      accountsWritten: accountsWritten,
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

const runtimeLayer = Layer.mergeAll(
  BrowserStorageLayers().pipe(Layer.provide(indexedDbLayer), Layer.orDie),
  SlotClockPreprod,
);

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

channel.addEventListener("message", (event) => {
  const msg: unknown = event.data;
  if (!isOffscreenRequest(msg)) return;

  handleDecode(msg.requestId, msg.payload).pipe(
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
