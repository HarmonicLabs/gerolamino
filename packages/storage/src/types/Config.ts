/**
 * StorageConfig — configuration for the storage layer.
 */
import { Schema } from "effect";

export const StorageConfig = Schema.Struct({
  securityParam: Schema.Number, // k (2160 for mainnet)
  maxBlockBodySize: Schema.Number, // for mempool capacity (2x this)
  snapshotInterval: Schema.Number, // how often to write LedgerDB snapshots
});
export type StorageConfig = Schema.Schema.Type<typeof StorageConfig>;
