// Browser-safe surface: the BlobStore service + key encoders. The
// Bun-only LSM layer (`bun:ffi`-backed `layerLsm`, `LsmAdmin`) lives in
// the `./lsm` sub-path; consumers that run in a Bun runtime import it
// as `from "lsm-ffi/lsm"`. Web/Chrome-extension hosts stick to this
// barrel so rolldown doesn't drag `bun:ffi` into the browser bundle.
export { BlobStore, BlobStoreError, BlobEntry, BlobStoreOperation } from "./blob-store.ts";
export {
  utxoKey,
  blockKey,
  blockIndexKey,
  stakeKey,
  accountKey,
  snapshotKey,
  cborOffsetKey,
  prefixEnd,
  PREFIX_UTXO,
  PREFIX_BLK,
  PREFIX_BIDX,
  PREFIX_STAK,
  PREFIX_ACCT,
  PREFIX_SNAP,
  PREFIX_COFF,
} from "./keys.ts";
