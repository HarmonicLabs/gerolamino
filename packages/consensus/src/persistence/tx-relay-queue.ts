/**
 * Tx-relay outbox — durable FIFO queue of transactions awaiting forward
 * to peers. Backed by `PersistedQueue` so submissions survive process
 * restarts (critical for mobile clients that lose connection mid-submit
 * and for SPOs that want at-least-once relay semantics).
 *
 * Producer (`Mempool` on `Accepted`): calls `offer(entry)`. Consumer
 * (future Phase 2e peer-outbox worker): calls `take(f)` — the handler
 * is given the decoded entry + metadata and is retried on failure up to
 * `maxAttempts` (default 10) before the entry is discarded.
 *
 * Exactly-once across restarts requires a SQL or Redis
 * `PersistedQueueStore` backend (Persistence research wave
 * §1/§2: `layerStoreMemory` is ephemeral, `layerStoreSql` / `layerStoreRedis`
 * durable). Tests use the memory backend; apps/bootstrap swaps SQL in at
 * its root layer.
 */
import { Effect, Layer, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";

import { MempoolEntry } from "../mempool/mempool";

/**
 * Queue name consumers target. Single namespace for the node's tx-relay
 * outbox — per-peer fan-out happens at the consumer side (take → forward
 * to N peer clients), not via separate queues.
 */
export const TX_RELAY_QUEUE_NAME = "consensus/tx-relay-outbox";

/** Entry schema — we serialize the full `MempoolEntry` so consumers can
 * re-derive fee-rate ordering + tx size without re-measuring.
 *
 * `feePerByte` is genuinely a float (lovelace ÷ bytes); `sizeBytes` is an
 * integer byte count, so use `Schema.Int` so a malformed serializer that
 * emits a float gets caught at decode time instead of producing nonsense
 * downstream. */
export const TxRelayEntry = Schema.Struct({
  txId: Schema.Uint8Array,
  txCbor: Schema.Uint8Array,
  addedSlot: Schema.BigInt,
  feePerByte: Schema.Number,
  sizeBytes: Schema.Int,
});
export type TxRelayEntry = typeof TxRelayEntry.Type;

/**
 * `TxRelayQueue` — the service facade producers + consumers depend on.
 * Wraps the raw `PersistedQueue` with the consensus-specific schema and
 * a friendlier `offerEntry(mempoolEntry)` producer shortcut.
 */
export const makeTxRelayQueue = Effect.gen(function* () {
  const queue = yield* PersistedQueue.make({
    name: TX_RELAY_QUEUE_NAME,
    schema: TxRelayEntry,
  });

  return {
    raw: queue,

    offerEntry: (entry: MempoolEntry) =>
      queue.offer({
        txId: entry.txId,
        txCbor: entry.txCbor,
        addedSlot: entry.addedSlot,
        feePerByte: entry.feePerByte,
        sizeBytes: entry.sizeBytes,
      }),

    /**
     * Consume one entry — handler runs inside a `Scope`; on failure the
     * entry is re-offered (attempt counter increments) up to
     * `options.maxAttempts` (default 10 per PersistedQueue contract).
     */
    takeEntry: <A, E, R>(
      handler: (
        entry: TxRelayEntry,
        metadata: { readonly id: string; readonly attempts: number },
      ) => Effect.Effect<A, E, R>,
      options?: { readonly maxAttempts?: number },
    ) => queue.take(handler, options),
  };
});

export type TxRelayQueue = Effect.Success<typeof makeTxRelayQueue>;

/**
 * Convenience: pre-composed test layer that wires the in-memory store
 * factory. Production apps compose `PersistedQueue.layer` with a
 * `layerStoreSql` or `layerStoreRedis` backing themselves.
 */
export const TxRelayQueueTestLayer = PersistedQueue.layer.pipe(
  Layer.provide(PersistedQueue.layerStoreMemory),
);
