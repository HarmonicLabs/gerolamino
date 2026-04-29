/* @ts-self-types="../result/wasm_plexer.d.ts" */
/**
 * wasm-init — Bun-side loader for the wasm-bindgen `bundler` target output.
 *
 * The bundler target's generated `wasm_plexer.js` wrapper does
 *
 *   import * as wasm from "./wasm_plexer_bg.wasm";
 *   __wbg_set_wasm(wasm);
 *   wasm.__wbindgen_start();
 *
 * which assumes the host bundler (webpack / vite) intercepts the `.wasm`
 * import and substitutes the live `WebAssembly.Instance.exports`. Bun's
 * ESM loader does NOT do that — `import wasm from "./foo.wasm"` resolves
 * to the file's path string (cf. `~/code/reference/bun/test/bundler/
 * bundler_loader.test.ts:96-100`), so `wasm.__wbindgen_start` is
 * `undefined` at runtime.
 *
 * This file is the Bun-native equivalent: top-level-await `Bun.file(...)
 * .arrayBuffer()` reads the binary, `WebAssembly.instantiate` is called
 * manually with the JS shim (`wasm_plexer_bg.js`) as the import object,
 * then `__wbg_set_wasm(instance.exports)` wires the shim's `wasm`
 * reference back to the live exports — exactly what the bundler-target
 * wrapper would do under webpack. Top-level await blocks the importing
 * module graph until WASM init completes, so consumers of this module's
 * re-exports see a fully-initialized API.
 *
 * Browser hosts (chrome-ext) use `packages/wasm-plexer/browser.js` —
 * the `fetch()`-based parallel loader.
 */
// wasm-bindgen's `_bg.js` shim doesn't ship its own `.d.ts` (only the
// public `wasm_plexer.d.ts` covers the bundle's user-facing surface).
// TypeScript can't augment a relative-path import via `declare module`,
// so we suppress the `implicitly has 'any'` warning explicitly here.
// The runtime contract is exercised by the round-trip tests in
// `src/__tests__/`, and the `@ts-self-types` directive at the top of
// this file gives downstream consumers the precise typings from
// `wasm_plexer.d.ts` regardless of the suppression below.
// @ts-expect-error — wasm-bindgen `_bg.js` shim has no .d.ts.
import * as bg from "../result/wasm_plexer_bg.js";
// @ts-expect-error — same shim, named import for the wasm-wiring helper.
import { __wbg_set_wasm } from "../result/wasm_plexer_bg.js";

const wasmPath = new URL("../result/wasm_plexer_bg.wasm", import.meta.url).pathname;
const wasmBytes = await Bun.file(wasmPath).arrayBuffer();
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  "./wasm_plexer_bg.js": bg,
});
__wbg_set_wasm(instance.exports);
// `__wbindgen_start` is the wasm-bindgen-emitted module-init entry point
// (declared via `#[wasm_bindgen(start)]` or implicit when the binary has
// a `start` section). The typeof guard narrows from `ExportValue`
// (function | memory | global | table) and also handles binaries that
// elide the export when no `start` section exists.
const start = instance.exports.__wbindgen_start;
if (typeof start === "function") start();

// Re-export the typed surface from the bg shim. The bundler-target
// `wasm_plexer.js` would re-export from the same `wasm_plexer_bg.js`,
// so consumer-facing identity is unchanged. The `@ts-self-types`
// directive at the top of this file means consumers see the precise
// typings from `wasm_plexer.d.ts` regardless of the inferred-`any`
// surface from this re-export.
export {
  FramingError,
  MultiplexerBuffer,
  unwrap_multiplexer_message,
  wrap_multiplexer_message,
  // @ts-expect-error — wasm-bindgen `_bg.js` shim has no .d.ts.
} from "../result/wasm_plexer_bg.js";
