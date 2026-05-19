/**
 * `lsm-wasm` — TypeScript adapter for the wasm32-wasi lsm-tree shim.
 *
 * Loads the reactor module compiled from `haskell/lsm-tree-wasm-shim`
 * and exposes a small set of typed entrypoints (`smoke`, `smokeReopen`
 * for now; full session/table surface lands when the shim's
 * `hs_lsm_*` export table grows).
 *
 * Two intended consumers:
 *
 * - **TUI** (apps/tui, Bun): instantiates with `node:wasi` (or a
 *   Bun-compatible WASI implementation). `preopens: { "/": "/" }` so
 *   the host filesystem is the LSM backing store.
 * - **chrome-ext** (browser): instantiates with `@bjorn3/browser_wasi_shim`
 *   v0.4.2+, backed by an OPFS `FileSystemSyncAccessHandle` running
 *   inside a dedicated Web Worker spawned from the offscreen document.
 *   Same lsm-tree binary, different storage backend.
 *
 * The module file (`lsm-tree-wasm.wasm`) is produced by
 * `haskell/lsm-tree-wasm-shim/build.sh` and lives alongside its
 * generated JS stub (`lsm-tree-wasm.js`).
 *
 * Errors surface as `LsmWasmError` discriminated by `operation` —
 * callers handle compile failures, instantiation faults, RTS-boot
 * issues, and per-reactor-call errors separately via
 * `Match.value(e.operation)`.
 */

export {
  loadLsmModule,
  LSM_RC,
  type CursorBatch,
  type LsmFactoryConfig,
  type LsmModule,
  type WasiAdapter,
} from "./module-loader.ts";
export { LsmWasmError, LsmWasmOperation, liftLsmError } from "./errors.ts";
export { layerLsmWasm, type LayerLsmWasmConfig } from "./blob-store.ts";
export { makeBunWasi, type BunWasiOptions } from "./bun-wasi.ts";
