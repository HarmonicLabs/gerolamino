/**
 * LedgerSnapshotStore — durable ledger-state snapshots + Praos nonce
 * triples for the consensus layer. BlobStore-only.
 *
 * The 4-method surface is used by:
 *   - `packages/consensus/src/sync/relay.ts` — resume-from-snapshot on
 *     reconnect.
 *   - `packages/consensus/src/sync/bootstrap.ts` — materialise a
 *     Mithril-delivered snapshot into local state.
 *   - `packages/consensus/src/praos/nonce.ts` + `sync/driver.ts` —
 *     persist per-epoch nonces so a restart replays from the last
 *     completed epoch boundary instead of re-deriving from genesis.
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
 *   `BlobStore.putBatch(...)`. LSM write batches are all-or-nothing.
 */
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
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
import type { RealPoint } from "../types/StoredBlock.ts";

/** Enumerates every `LedgerSnapshotStore` entry point — mirrors `ChainDBOperation`. */
export const LedgerSnapshotOperation = Schema.Literals([
  "writeLedgerSnapshot",
  "readLatestLedgerSnapshot",
  "writeNonces",
  "readNonces",
]);
export type LedgerSnapshotOperation = typeof LedgerSnapshotOperation.Type;

/** Error surface — separate from `ChainDBError` so callers that only need
 * snapshot/nonce ops don't have to handle chain-DB failure modes. */
export class LedgerSnapshotError extends Schema.TaggedErrorClass<LedgerSnapshotError>()(
  "LedgerSnapshotError",
  {
    operation: LedgerSnapshotOperation,
    cause: Schema.Defect,
  },
) {}

export class LedgerSnapshotStore extends Context.Service<
  LedgerSnapshotStore,
  {
    /** Persist a ledger state snapshot at `(slot, hash, epoch)`. Upserts on
     * `slot` conflict so repeated writes at the same slot refresh the hash. */
    readonly writeLedgerSnapshot: (
      slot: bigint,
      hash: Uint8Array,
      epoch: bigint,
      stateBytes: Uint8Array,
    ) => Effect.Effect<void, LedgerSnapshotError>;

    /** Read the most-recent persisted snapshot. */
    readonly readLatestLedgerSnapshot: Effect.Effect<
      Option.Option<{ point: RealPoint; stateBytes: Uint8Array; epoch: bigint }>,
      LedgerSnapshotError
    >;

    /** Persist nonces for a given epoch. Upserts on `epoch` conflict. */
    readonly writeNonces: (
      epoch: bigint,
      active: Uint8Array,
      evolving: Uint8Array,
      candidate: Uint8Array,
    ) => Effect.Effect<void, LedgerSnapshotError>;

    /** Read the most-recent persisted nonces. */
    readonly readNonces: Effect.Effect<
      Option.Option<{
        epoch: bigint;
        active: Uint8Array;
        evolving: Uint8Array;
        candidate: Uint8Array;
      }>,
      LedgerSnapshotError
    >;
  }
>()("storage/LedgerSnapshotStore") {}

const withOp =
  (operation: LedgerSnapshotOperation) =>
  <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, LedgerSnapshotError, R> =>
    Effect.mapError(effect, (cause) => new LedgerSnapshotError({ operation, cause }));

const readLatestLedgerSnapshot = Effect.fn("LedgerSnapshotStore.readLatest")(function* (
  store: Context.Service.Shape<typeof BlobStore>,
) {
  // `BlobStore.scan` is lex (= slot ASC) for big-endian keys; the stream
  // tail is the highest slot. `Stream.runLast` avoids materialising the
  // full prefix (handoff: not runCollect + .at(-1)).
  const tail = yield* Stream.runLast(store.scan(PREFIX_SMET));
  if (Option.isNone(tail)) {
    return Option.none<{ point: RealPoint; stateBytes: Uint8Array; epoch: bigint }>();
  }
  const slot = decodeSnapshotMetaSlot(tail.value.key);
  const meta = decodeSnapshotMeta(tail.value.value);
  const blobOpt = yield* store.get(snapshotKey(slot));
  return Option.map(blobOpt, (stateBytes) => ({
    point: { slot, hash: meta.hash },
    stateBytes,
    epoch: meta.epoch,
  }));
});

const readNonces = Effect.fn("LedgerSnapshotStore.readNonces")(function* (
  store: Context.Service.Shape<typeof BlobStore>,
) {
  const tail = yield* Stream.runLast(store.scan(PREFIX_NNCE));
  if (Option.isNone(tail)) {
    return Option.none<{
      epoch: bigint;
      active: Uint8Array;
      evolving: Uint8Array;
      candidate: Uint8Array;
    }>();
  }
  const epoch = decodeNoncesEpoch(tail.value.key);
  const { active, evolving, candidate } = decodeNoncesValue(tail.value.value);
  return Option.some({ epoch, active, evolving, candidate });
});

export const LedgerSnapshotStoreLive: Layer.Layer<LedgerSnapshotStore, never, BlobStore> =
  Layer.effect(
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

        readLatestLedgerSnapshot: readLatestLedgerSnapshot(store).pipe(
          withOp("readLatestLedgerSnapshot"),
        ),

        writeNonces: (epoch, active, evolving, candidate) =>
          store
            .put(noncesKey(epoch), encodeNoncesValue(active, evolving, candidate))
            .pipe(withOp("writeNonces")),

        readNonces: readNonces(store).pipe(withOp("readNonces")),
      };
    }),
  );
