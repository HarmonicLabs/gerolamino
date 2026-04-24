/**
 * Thin re-export. Prefix key constructors live in `ffi` alongside
 * `BlobStore` because the byte-level key layout is tied to the LSM scan
 * semantics.
 */
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
} from "lsm-ffi";
