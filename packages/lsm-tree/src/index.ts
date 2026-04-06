// BlobStore service + keys are defined in packages/storage.
// This package provides the LSM tree implementation layer (Bun FFI).
// Re-export from storage for convenience.
export { BlobStore, BlobStoreError, type BlobStoreShape } from "storage/blob-store/service";
export {
  utxoKey,
  blockKey,
  blockIndexKey,
  stakeKey,
  accountKey,
  cborOffsetKey,
  prefixEnd,
  PREFIX_UTXO,
  PREFIX_BLK,
  PREFIX_BIDX,
  PREFIX_STAK,
  PREFIX_ACCT,
  PREFIX_COFF,
} from "storage/blob-store/keys";
export { layerLsm } from "./layer-lsm";
