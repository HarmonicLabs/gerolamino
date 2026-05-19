// Browser-safe surface: the BlobStore service + key encoders + the
// WASM lsm-tree adapter. The Bun-only LSM layer (`bun:ffi`-backed
// `layerLsm`, `LsmAdmin`) lives in the `./lsm` sub-path; consumers
// that run in a Bun runtime import it as `from "lsm-ffi/lsm"`.
// Chrome-extension hosts stick to this barrel + the `lsm-wasm`
// re-exports so rolldown doesn't drag `bun:ffi` into the browser bundle.
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
export {
  loadLsmModule,
  LSM_RC,
  LsmWasmError,
  LsmWasmOperation,
  layerLsmWasm,
  makeBunWasi,
  type BunWasiOptions,
  type CursorBatch,
  type LayerLsmWasmConfig,
  type LsmFactoryConfig,
  type LsmModule,
  type WasiAdapter,
} from "./wasm/index.ts";
