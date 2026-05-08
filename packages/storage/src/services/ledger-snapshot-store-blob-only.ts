/**
 * `LedgerSnapshotStore` — BlobStore-only variant for chrome-ext SW.
 *
 * The SQL-backed sibling at `./ledger-snapshot-store.ts` is the canonical
 * implementation for Bun (apps/tui, apps/bootstrap). This file ships a
 * second `Layer` exposing the same service tag with no SQL / Drizzle
 * dependency — chrome-ext SW context can't run SQLite-WASM durably and
 * has no SQL-shaped queries anyway.
 *
 * Storage layout (see `../blob-store/chain-keys.ts`):
 *   - Snapshot blob:   `snap:{slot}`        → state bytes (≤ 50 MB)
 *   - Snapshot meta:   `smet:{slot}`        → `hash(32B) ∥ epoch(8B BE)`
 *   - Nonce row:       `nnce:{epoch}`       → `active ∥ evolving ∥ candidate`
 *
 * "Latest" is computed by scanning the `smet` / `nnce` prefix and
 * picking the max-keyed entry. `BlobStore.scan(prefix)` returns
 * entries in lexicographic byte order (= numeric slot/epoch order
 * because we encode big-endian); iterating to the end and keeping
 * the last gives O(n) worst-case, where n = snapshot count
 * (typically ≤ 30 over a node's lifetime — at most one per epoch).
 *
 * Atomicity:
 *   `writeLedgerSnapshot` writes the blob + the metadata in one
 *   `BlobStore.putBatch(...)`. IndexedDB scopes the batch to a single
 *   transaction; LSM (on Bun) wraps it in a write batch. Both are
 *   all-or-nothing.
 */
import { Effect, Layer, Option, Stream } from "effect";
import { BlobStore, snapshotKey } from "../blob-store";
import {
  decodeNoncesEpoch,
  decodeNoncesValue,
  decodeSnapshotMeta,
  decodeSnapshotMetaSlot,
  encodeNoncesValue,
  encodeSnapshotMeta,
  noncesKey,
  PREFIX_NNCE,
  PREFIX_SMET,
  snapshotMetaKey,
} from "../blob-store/chain-keys.ts";
// Reuse the canonical Service tag + error class from the SQL-backed
// sibling so consumers can swap Layers transparently — `Effect.gen(function*()
// { const store = yield* LedgerSnapshotStore; ... })` resolves to whichever
// Layer the app provided.
import { LedgerSnapshotError, LedgerSnapshotStore } from "./ledger-snapshot-store.ts";
import type { RealPoint } from "../types/StoredBlock.ts";

type SnapshotOp = "writeLedgerSnapshot" | "readLatestLedgerSnapshot" | "writeNonces" | "readNonces";

const withOp =
  (operation: SnapshotOp) =>
  <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, LedgerSnapshotError, R> =>
    Effect.mapError(effect, (cause) => new LedgerSnapshotError({ operation, cause }));

/**
 * BlobStore-only Layer. Only depends on `BlobStore` — explicitly NOT on
 * `SqlClient`. Drop-in replacement for `LedgerSnapshotStoreLive` in
 * environments without SQL (chrome-ext SW).
 */
export const LedgerSnapshotStoreBlobOnlyLive: Layer.Layer<
  LedgerSnapshotStore,
  never,
  BlobStore
> = Layer.effect(
  LedgerSnapshotStore,
  Effect.gen(function* () {
    const store = yield* BlobStore;

    return {
      writeLedgerSnapshot: (slot, hash, epoch, stateBytes) =>
        store
          .putBatch([
            { key: snapshotKey(slot), value: stateBytes },
            { key: snapshotMetaKey(slot), value: encodeSnapshotMeta(hash, epoch) },
          ])
          .pipe(withOp("writeLedgerSnapshot")),

      readLatestLedgerSnapshot: Effect.gen(function* () {
        // Scan all `smet:` entries in lex (= slot ASC) order; reduce to the
        // last one. Snapshot count is ≤ 30 over a node lifetime, so O(n)
        // is fine. Keeping the scan-then-take-last shape (instead of
        // streaming-and-tracking-max) keeps the implementation honest:
        // we want the highest-keyed entry, which equals the last in lex
        // order for our big-endian slot encoding.
        const entries = yield* Stream.runCollect(store.scan(PREFIX_SMET));
        if (entries.length === 0) {
          return Option.none<{ point: RealPoint; stateBytes: Uint8Array; epoch: bigint }>();
        }
        const last = entries[entries.length - 1]!;
        const slot = decodeSnapshotMetaSlot(last.key);
        const meta = decodeSnapshotMeta(last.value);
        const blobOpt = yield* store.get(snapshotKey(slot));
        return Option.map(blobOpt, (stateBytes) => ({
          point: { slot, hash: meta.hash },
          stateBytes,
          epoch: meta.epoch,
        }));
      }).pipe(withOp("readLatestLedgerSnapshot")),

      writeNonces: (epoch, active, evolving, candidate) =>
        store
          .put(noncesKey(epoch), encodeNoncesValue(active, evolving, candidate))
          .pipe(withOp("writeNonces")),

      readNonces: Effect.gen(function* () {
        // Same pattern as `readLatestLedgerSnapshot` — lex order over
        // big-endian epoch keys equals numeric epoch order, so the last
        // scanned entry is the most recent. Nonce-triple count is also
        // bounded (one per epoch transition).
        const entries = yield* Stream.runCollect(store.scan(PREFIX_NNCE));
        if (entries.length === 0) {
          return Option.none<{
            epoch: bigint;
            active: Uint8Array;
            evolving: Uint8Array;
            candidate: Uint8Array;
          }>();
        }
        const last = entries[entries.length - 1]!;
        const epoch = decodeNoncesEpoch(last.key);
        const { active, evolving, candidate } = decodeNoncesValue(last.value);
        return Option.some({ epoch, active, evolving, candidate });
      }).pipe(withOp("readNonces")),
    };
  }),
);
