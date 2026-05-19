/**
 * Extracted Mithril snapshot-decode pipeline (Phase D Step 6).
 *
 * The decode flow used to live inside `entrypoints/offscreen/main.ts`
 * as a `handleDecode(requestId, payload)` Effect that posted progress
 * + completion messages directly onto the legacy
 * `gerolamino/offscreen` BroadcastChannel. The wave-15 architecture
 * inversion means atom writers now live alongside the registry in the
 * offscreen, and the `LedgerState` handler in
 * `entrypoints/offscreen/bootstrap-sync.ts` would benefit from
 * calling this directly — the prior shape forced a same-process
 * BroadcastChannel round-trip.
 *
 * This module exposes a callback-based version: the caller supplies
 * an `onProgress` Effect that receives each progress update, and the
 * function returns the decoded `DecodeResult` on completion. Two
 * consumers feed it:
 *   - The legacy listener in `main.ts` wraps the callback to post
 *     `{ tag: "decode-progress", requestId, ... }` messages onto the
 *     channel + posts `{ tag: "decode-complete", ... }` after.
 *     Surfaced for any external caller still using the legacy
 *     decode-protocol (effectively no one after Step 6 ships).
 *   - The offscreen-side `bootstrap-sync.ts::LedgerState` handler
 *     (Step 6 follow-up) passes a callback that calls
 *     `pushBootstrapProgress({...})` directly — atom writes flow
 *     into the offscreen-local registry without round-tripping
 *     through structured-clone.
 *
 * The function is `Storage`-agnostic at its surface: it takes
 * `BlobStore` from the Effect context, just like the prior
 * `handleDecode`. Both consumers provide it via `BrowserStorageLayers`
 * with their own IndexedDb layer composition.
 */
import { Effect, HashMap, Stream } from "effect";
import { extractLedgerView, extractNonces, extractSnapshotTip } from "consensus";
import type { LedgerView, Nonces, SlotClock } from "consensus";
import { decodeExtLedgerState } from "ledger";
import { type BlobEntry, BlobStore, accountKey, stakeKey } from "storage";
import type { BootstrapPhase } from "dashboard/atoms";
import { encodeAccountValue } from "../background/account-encoder.ts";

/** Per-tick progress payload. Identical shape across both legacy
 *  (BroadcastChannel) and direct (atom-push) callers — the wire-side
 *  serialization adds `tag: "decode-progress"` + `requestId`, and the
 *  atom-push side calls `pushBootstrapProgress` with this struct
 *  directly. */
export type DecodeProgress = {
  readonly phase: BootstrapPhase;
  readonly accountsWritten: number;
  readonly totalAccounts?: number;
  readonly stakeEntriesWritten: number;
  readonly totalStakeEntries?: number;
};

/** Decoded snapshot result. Native `LedgerView` + `Nonces` shapes
 *  (HashMap-typed) — no SerializedLedgerView round-trip when called
 *  directly. The legacy listener calls `serializeLedgerView` itself
 *  on this. */
export type DecodeResult = {
  readonly ledgerView: LedgerView;
  readonly nonces: Nonces;
  readonly tip:
    | { readonly slot: bigint; readonly blockNo: bigint; readonly hash: Uint8Array }
    | undefined;
  readonly accountsWritten: number;
  readonly stakeEntriesWritten: number;
};

/** 100 k-row IndexedDB transactions. Per the wave-12 doc-comment in
 *  the original `handleDecode`: 100 k chunks fit well within
 *  Chromium's per-tx limits and amortise per-transaction overhead
 *  ~10× vs the original 5 k chunks. The streaming-encode shape avoids
 *  the 1.5 GB pre-materialised `BlobEntry[]` peak the older
 *  Array-of-everything approach hit. */
const ACCOUNT_CHUNK = 100_000;

/**
 * Decode the Mithril snapshot CBOR bytes into a `LedgerView` +
 * `Nonces` + `tip` and write the resulting accounts + stake entries
 * to the supplied `BlobStore`. Streams progress updates via the
 * `onProgress` callback at every ACCOUNT_CHUNK-sized batch flush + at
 * the start of stake-entry writes.
 *
 * Required services: `BlobStore`. Caller composes it via
 * `BrowserStorageLayers` (offscreen-local IndexedDB).
 */
export const decodeExtLedgerStateOffscreen = (
  payload: Uint8Array,
  onProgress: (msg: DecodeProgress) => Effect.Effect<void>,
): Effect.Effect<DecodeResult, unknown, BlobStore | SlotClock> =>
  Effect.gen(function* () {
    const store = yield* BlobStore;

    yield* Effect.log(`[offscreen-decode] Decoding ExtLedgerState (${payload.length} bytes)...`);
    yield* onProgress({
      phase: "decoding-ledger-state",
      accountsWritten: 0,
      stakeEntriesWritten: 0,
    });

    const extState = yield* decodeExtLedgerState(payload);
    yield* Effect.log(
      `[offscreen-decode] Decoded: era ${extState.currentEra}, epoch ${extState.newEpochState.epoch}, ` +
        `${HashMap.size(extState.newEpochState.poolDistr.pools)} pools`,
    );

    const lv = yield* extractLedgerView(extState);
    const nonces = extractNonces(extState);
    const tip = extractSnapshotTip(extState);

    // --- Accounts ---
    // Streaming pipeline: lazily pull `(credential, acct)` pairs from
    // the HashMap, encode each into a `BlobEntry`, batch
    // ACCOUNT_CHUNK-sized groups, `putBatch` per group. Peak working
    // set is one chunk (~20 MB), not the full account set.
    const accounts = extState.newEpochState.epochState.ledgerState.certState.dState.accounts;
    const totalAccounts = HashMap.size(accounts);
    yield* Effect.log(
      `[offscreen-decode] Writing ${totalAccounts} accounts (chunks of ${ACCOUNT_CHUNK})`,
    );
    yield* onProgress({
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
            yield* onProgress({
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
    yield* Effect.log(`[offscreen-decode] Accounts written (${accountsWritten})`);

    // --- Stake distribution ---
    const stakeEntries: Array<BlobEntry> = Array.from(
      HashMap.entries(lv.poolStake),
      ([poolHashHex, stake]) => {
        const val = new Uint8Array(8);
        new DataView(val.buffer).setBigUint64(0, stake);
        return { key: stakeKey(Uint8Array.fromHex(poolHashHex)), value: val };
      },
    );
    const totalStakeEntries = stakeEntries.length;
    yield* Effect.log(`[offscreen-decode] Writing ${totalStakeEntries} stake entries`);
    yield* onProgress({
      phase: "writing-stake",
      accountsWritten,
      totalAccounts,
      stakeEntriesWritten: 0,
      totalStakeEntries,
    });
    if (stakeEntries.length > 0) {
      yield* store.putBatch(stakeEntries);
    }
    yield* onProgress({
      phase: "writing-stake",
      accountsWritten,
      totalAccounts,
      stakeEntriesWritten: totalStakeEntries,
      totalStakeEntries,
    });
    yield* Effect.log(`[offscreen-decode] Stake entries written (${totalStakeEntries})`);

    return {
      ledgerView: lv,
      nonces,
      tip,
      accountsWritten,
      stakeEntriesWritten: totalStakeEntries,
    } satisfies DecodeResult;
  });
