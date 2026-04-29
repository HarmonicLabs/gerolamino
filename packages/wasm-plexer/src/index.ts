/**
 * wasm-plexer barrel — Ouroboros multiplexer framing.
 *
 * Preferred API: `MuxFraming` + `FrameBuffer` services.
 * Raw wasm-bindgen exports re-exported for back-compat with legacy
 * consumers; new code should go through the services.
 */

export * from "./errors.ts";
export * from "./schemas.ts";
export * from "./service.ts";

// `./wasm-init.ts` performs the WASM instantiation via top-level await
// before re-exporting these symbols, so by the time this barrel is
// imported anywhere downstream the live `WebAssembly.Instance.exports`
// are already wired into the bg-shim (cf. `wasm-init.ts` for why we
// can't import the bundler-target `wasm_plexer.js` directly under Bun).
export {
  FramingError,
  MultiplexerBuffer,
  unwrap_multiplexer_message,
  wrap_multiplexer_message,
} from "./wasm-init.ts";

/**
 * No-op `init()` for Bun consumers — top-level await in `./wasm-init.ts`
 * has already wired the WASM exports by the time anything imports from
 * this barrel, so calling `init()` is just a `Promise.resolve()`.
 *
 * Browser hosts (chrome-ext) consume `packages/wasm-plexer/browser.js`
 * via a build-time alias; that file overrides this export with the
 * fetch-based loader. The export keeps tsgo happy when the chrome-ext
 * sources `import { init } from "wasm-plexer"` against the source-tree
 * path resolution — at runtime the alias swaps in the real loader.
 */
export const init = (): Promise<void> => Promise.resolve();
