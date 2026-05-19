/**
 * Asset URLs for the Haskell-compiled lsm-tree WASM shim.
 *
 * Centralised here so consumers (offscreen worker, Bun TUI, tests)
 * import via the `wasm-utils` barrel rather than spelling out a deep
 * `../../../../wasm-utils/haskell-lsm/...` path from outside the
 * package. `new URL(..., import.meta.url)` is Vite's canonical asset
 * pattern — the bundler rewrites the URL to point at the emitted
 * asset chunk at build time.
 */

export const lsmTreeWasmUrl: URL = new URL(
  "../../haskell-lsm/lsm-tree-wasm-shim/lsm-tree-wasm.wasm",
  import.meta.url,
);

export const lsmTreeJsffiUrl: URL = new URL(
  "../../haskell-lsm/lsm-tree-wasm-shim/lsm-tree-wasm.js",
  import.meta.url,
);
