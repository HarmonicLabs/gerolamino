/**
 * Mempool types — transaction buffer for pending transactions.
 */
import { Schema } from "effect";

export const MempoolTx = Schema.Struct({
  txId: Schema.Uint8Array, // 32 bytes
  txCbor: Schema.Uint8Array,
  txSizeBytes: Schema.Number,
  addedAt: Schema.Number, // monotonic counter for FIFO ordering
});
export type MempoolTx = Schema.Schema.Type<typeof MempoolTx>;

export const MempoolSnapshot = Schema.Struct({
  txs: Schema.Array(MempoolTx),
  totalBytes: Schema.Number,
  snapshotNo: Schema.Number,
});
export type MempoolSnapshot = Schema.Schema.Type<typeof MempoolSnapshot>;
