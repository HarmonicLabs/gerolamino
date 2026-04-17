/**
 * Browser-compatible loader for wasm-plexer.
 *
 * wasm-plexer is compiled with wasm-bindgen target=bundler, which doesn't
 * provide a fetch-based init() like target=web does. This loader provides
 * the same pattern: an init() that uses fetch() to load the WASM binary,
 * compatible with Chrome MV3 service workers.
 *
 * Consumers import { MultiplexerBuffer, ... } as usual — but init() MUST
 * be called before any of those exports are used.
 */
/* @ts-self-types="./result/wasm_plexer.d.ts" */
import * as bg from "./result/wasm_plexer_bg.js";
import { __wbg_set_wasm } from "./result/wasm_plexer_bg.js";

let initialized = false;

/**
 * Initialize the wasm-plexer WASM module via fetch().
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function init() {
  if (initialized) return;
  const wasmUrl = new URL("./result/wasm_plexer_bg.wasm", import.meta.url);
  const response = await fetch(wasmUrl);
  const wasmBytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(wasmBytes, { "./wasm_plexer_bg.js": bg });
  __wbg_set_wasm(instance.exports);
  instance.exports.__wbindgen_start();
  initialized = true;
}

export {
  MultiplexerBuffer,
  unwrap_multiplexer_message,
  wrap_multiplexer_message,
} from "./result/wasm_plexer_bg.js";
