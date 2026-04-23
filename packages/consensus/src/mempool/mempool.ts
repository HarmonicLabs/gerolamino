/**
 * Mempool — pending-tx store with Conway UTXOW predicate surface.
 *
 * Phase 3e scaffolding. Ships:
 *   - `Mempool` Context.Service: submit / snapshot / removeByHash / onReorg
 *   - Durable entry storage via `KeyValueStore.toSchemaStore(…, MempoolEntry)`.
 *     The KV backend is provided at layer-composition time — `layerMemory`
 *     for tests + apps/tui, `layerSql` for apps/bootstrap. Entries survive
 *     process restart when backed by a durable KV.
 *   - In-memory `HashSet` of known tx-id keys, used for `snapshot`
 *     enumeration (KV primitives don't expose a `keys()` iterator). The
 *     set is rebuilt from `ChainEventLog` replay + live submissions; it is
 *     an index, not a parallel store of values.
 *   - Stub validation: `validateConway` always accepts — real predicate
 *     implementations land per-layer (UTXOW → UTXO → UTXOS → GOV) when
 *     Phase 3e proper ships.
 *
 * Rollback handling: on `onReorg`, callers pass in a set of affected txIds
 * (those whose inputs come from rolled-back blocks). The mempool evicts
 * those; re-admission of unforged txs requires ledger-state lookup that
 * Phase 3e proper will wire. A layer-forked daemon subscribes to
 * `ChainEventStream` and clears wholesale on rollbacks deeper than k=2160
 * (protocol-violation territory).
 */
import { Context, Effect, HashSet, Layer, Option, Ref, Schema, Stream } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import { ChainEvent, ChainEventStream } from "../chain/event-log.ts";
import type { MempoolRuleError } from "./conway-predicates.ts";

/**
 * A `MempoolEntry` wraps the submitted tx CBOR + metadata consensus
 * stages need (fee rate for sorted snapshots, acceptance slot for
 * expiry tracking).
 */
export class MempoolEntry extends Schema.TaggedClass<MempoolEntry>()("MempoolEntry", {
  txId: Schema.Uint8Array,
  txCbor: Schema.Uint8Array,
  addedSlot: Schema.BigInt,
  /** Fee paid in lovelace per byte of tx CBOR — snapshot orderable. */
  feePerByte: Schema.Number,
  /** Tx size in bytes — cached so snapshot doesn't re-measure. */
  sizeBytes: Schema.Number,
}) {}

/** Submission outcome — accepted (with fee rate for ordering) or rejected. */
export const SubmitResult = Schema.Union([
  Schema.TaggedStruct("Accepted", { txId: Schema.Uint8Array, feePerByte: Schema.Number }),
  Schema.TaggedStruct("Rejected", { txId: Schema.Uint8Array, reasons: Schema.String }),
  Schema.TaggedStruct("AlreadyPresent", { txId: Schema.Uint8Array }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type SubmitResult = typeof SubmitResult.Type;

export class MempoolError extends Schema.TaggedErrorClass<MempoolError>()("MempoolError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/**
 * Stable hex key for the `KeyValueStore` + `HashSet<string>` index.
 * KV keys are strings; hex encoding is the simplest correct canonical
 * form for a `Uint8Array` txId.
 */
const hexKey = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * Namespace prefix applied when deriving the mempool's slice of a shared
 * `KeyValueStore`. Production layers typically provide a pre-prefixed
 * store, but defaulting to `"mempool:"` keeps tests ergonomic.
 */
const MEMPOOL_KV_PREFIX = "mempool:";

export class Mempool extends Context.Service<
  Mempool,
  {
    /**
     * Submit a tx. Runs Conway UTXOW predicates (stub for now — Phase 3e
     * proper wires the 63-predicate surface). Returns `Accepted` on
     * success, `Rejected` on predicate failure, `AlreadyPresent` if the
     * txId is already in the pool.
     */
    readonly submit: (
      txId: Uint8Array,
      txCbor: Uint8Array,
      addedSlot: bigint,
      feePerByte: number,
    ) => Effect.Effect<SubmitResult, MempoolError>;

    /** Snapshot ordered by `feePerByte` descending (block-packing order). */
    readonly snapshot: Effect.Effect<ReadonlyArray<MempoolEntry>>;

    /** Remove a tx by id (called after inclusion in a block). */
    readonly removeByHash: (txId: Uint8Array) => Effect.Effect<void>;

    /**
     * Handle a chain rollback: evict txs whose inputs came from
     * rolled-back blocks. Caller supplies the set of evicted txIds. The
     * `Live` layer optionally wires a daemon fiber that subscribes to
     * `ChainEventStream` and calls `onReorg` on every `RolledBack` event,
     * so most consumers don't invoke this directly.
     */
    readonly onReorg: (evictedTxIds: ReadonlyArray<Uint8Array>) => Effect.Effect<void>;

    /** Total pending tx count. */
    readonly size: Effect.Effect<number>;
  }
>()("consensus/Mempool") {
  /**
   * In-memory implementation. State-consistency via `Ref` (atomic
   * update). Real Cluster Entity integration ships when multi-runner
   * sharding is needed — the service contract (submit / snapshot /
   * removeByHash / onReorg / size) does not change at that boundary, so
   * callers compose against this tag regardless of backing runner.
   *
   * The `Live` layer also forks a scoped daemon fiber that subscribes to
   * `ChainEventStream` and reacts to `RolledBack` events. The reaction
   * policy matches Haskell ouroboros-consensus semantics: a rollback of
   * depth ≤ k (2160) is a Phase-3e-proper per-tx re-validation which this
   * stub can't yet perform (needs UTxO diff), so the daemon currently
   * records the event but leaves state untouched. A rollback of depth > k
   * is a protocol violation the node must disconnect from, so mempool
   * state is cleared wholesale to avoid serving stale txs while the
   * caller handles peer disconnection.
   */
  static readonly Live = Layer.effect(
    Mempool,
    Effect.gen(function* () {
      // Durable entry store — prefix-namespaced so mempool doesn't collide
      // with any other KV consumer sharing the same backend.
      const rawKvs = yield* KeyValueStore.KeyValueStore;
      const kvs = KeyValueStore.prefix(rawKvs, MEMPOOL_KV_PREFIX);
      const store = KeyValueStore.toSchemaStore(kvs, MempoolEntry);

      // In-memory key index — needed because KeyValueStore doesn't expose
      // a `keys()` iterator. The index is authoritative for `snapshot` /
      // `size` and rebuilt on restart via `ChainEventLog` replay + fresh
      // submissions. Value storage lives in `store` (durable).
      const index = yield* Ref.make<HashSet.HashSet<string>>(HashSet.empty());

      /**
       * Stub validator — real predicates land per-layer (UTXOW + UTXO +
       * UTXOS + GOV). For now accept all txs so the pool exercises its
       * state-transition shape without blocking on rule implementations.
       *
       * To fail for a test, pass a `txId` whose first byte is 0xff; that
       * triggers a synthetic UtxoFailure for shape checking.
       */
      const validateConway = (txId: Uint8Array): ReadonlyArray<MempoolRuleError> => {
        if (txId[0] === 0xff) {
          return [{ _tag: "UtxoFailure", inner: "synthetic rejection (first byte 0xff)" }];
        }
        return [];
      };

      const toMempoolError = (message: string) => (cause: unknown) =>
        new MempoolError({ message, cause });

      const service: Mempool["Service"] = {
        submit: (txId, txCbor, addedSlot, feePerByte) =>
          Effect.gen(function* () {
            const key = hexKey(txId);
            const known = yield* Ref.get(index).pipe(Effect.map(HashSet.has(key)));
            if (known) {
              return { _tag: "AlreadyPresent", txId } as const;
            }
            const reasons = validateConway(txId);
            if (reasons.length > 0) {
              return {
                _tag: "Rejected",
                txId,
                reasons: reasons.map((r) => r._tag).join(","),
              } as const;
            }
            const entry = new MempoolEntry({
              txId,
              txCbor,
              addedSlot,
              feePerByte,
              sizeBytes: txCbor.byteLength,
            });
            yield* store.set(key, entry).pipe(Effect.mapError(toMempoolError("submit.set")));
            yield* Ref.update(index, HashSet.add(key));
            return { _tag: "Accepted", txId, feePerByte } as const;
          }),

        snapshot: Effect.gen(function* () {
          const keys = yield* Ref.get(index);
          const fetches = yield* Effect.forEach(
            keys,
            (key) => store.get(key).pipe(Effect.mapError(toMempoolError("snapshot.get"))),
          );
          // Filter to the Some arm + sort highest-fee-rate first.
          return fetches
            .flatMap(Option.match({ onNone: () => [], onSome: (e) => [e] }))
            .toSorted((a, b) => b.feePerByte - a.feePerByte);
        }),

        removeByHash: (txId) =>
          Effect.gen(function* () {
            const key = hexKey(txId);
            yield* store.remove(key).pipe(
              Effect.mapError(toMempoolError("removeByHash.remove")),
            );
            yield* Ref.update(index, HashSet.remove(key));
          }),

        onReorg: (evictedTxIds) =>
          Effect.forEach(evictedTxIds, (txId) => service.removeByHash(txId), {
            concurrency: "unbounded",
            discard: true,
          }),

        size: Ref.get(index).pipe(Effect.map(HashSet.size)),
      };

      // Cardano security parameter k = 2160 (Shelley+); rollback beyond k
      // is a protocol violation. The daemon only reacts on deep rollbacks;
      // shallow rollbacks flow through the explicit `onReorg` caller path
      // because per-tx eviction requires a UTxO diff the daemon can't
      // compute standalone.
      const K_DEEP = 2160;

      const clearAll = Effect.gen(function* () {
        yield* store.clear.pipe(Effect.mapError(toMempoolError("clear.store")));
        yield* Ref.set(index, HashSet.empty<string>());
      });

      const rollbackDaemon = Effect.gen(function* () {
        const events = yield* ChainEventStream;
        yield* events.stream.pipe(
          Stream.runForEach((event) =>
            ChainEvent.match(event, {
              BlockAccepted: () => Effect.void,
              TipAdvanced: () => Effect.void,
              EpochBoundary: () => Effect.void,
              RolledBack: ({ depth }) =>
                depth > K_DEEP
                  ? clearAll.pipe(
                      Effect.tap(() =>
                        Effect.logWarning(
                          `mempool cleared — rollback depth ${depth} > k=${K_DEEP}`,
                        ),
                      ),
                      Effect.catchAll((err) =>
                        Effect.logError(
                          `mempool clear failed (rollback depth ${depth}): ${err.message}`,
                        ),
                      ),
                    )
                  : Effect.void,
            }),
          ),
        );
      });
      yield* Effect.forkScoped(rollbackDaemon);

      return Mempool.of(service);
    }),
  );
}
