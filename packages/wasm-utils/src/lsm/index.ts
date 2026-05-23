// Browser-safe surface: BlobStore key encoders + WASM lsm-tree adapter.
// Chrome-extension and Bun TUI both use `layerLsmWasm` / `loadLsmModule`;
// the Haskell-compiled reactor lives under `haskell-lsm/lsm-tree-wasm-shim/`.
export { BlobStore, BlobStoreError, BlobEntry, BlobStoreOperation } from "./blob-store.ts";
export { LsmAdmin, LsmAdminError, LsmAdminOperation } from "./admin.ts";
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
export { lsmTreeWasmUrl, lsmTreeJsffiUrl } from "../lsm-shim/urls.ts";
