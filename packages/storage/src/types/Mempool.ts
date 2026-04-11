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
export type MempoolTx = typeof MempoolTx.Type;

export const MempoolSnapshot = Schema.Struct({
  txs: Schema.Array(MempoolTx),
  totalBytes: Schema.Number,
  snapshotNo: Schema.Number,
});
export type MempoolSnapshot = typeof MempoolSnapshot.Type;
