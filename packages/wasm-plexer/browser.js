/**
 * Browser-host loader for wasm-plexer (Chrome MV3 service workers,
 * regular tabs, content scripts).
 *
 * wasm-plexer is compiled with wasm-bindgen `target=bundler`, whose
 * generated `wasm_plexer.js` does
 *
 *   import * as wasm from "./wasm_plexer_bg.wasm";
 *   __wbg_set_wasm(wasm);
 *   wasm.__wbindgen_start();
 *
 * relying on the host bundler to substitute the live
 * `WebAssembly.Instance.exports` for the `.wasm` import. Vite (used by
 * WXT for the chrome-ext popup + SW) doesn't do that substitution
 * automatically; without intervention every wasm-plexer call resolves
 * `wasm.<fn>` against `undefined` and the SW dies with
 * `Cannot read properties of undefined (reading 'multiplexerbuffer_new')`.
 *
 * We can't use top-level await here either: MV3 service workers do
 * register an ESM with `type: "module"`, but if the TLA promise pends
 * during the registration handshake the SW never reaches a runnable
 * state and Chrome stops emitting logs entirely. So the loader exports
 * an explicit `init()` instead, idempotent + cached so multiple call
 * sites are safe; the chrome-ext SW awaits it once at boot, before any
 * miniprotocols code runs.
 */
/* @ts-self-types="./result/wasm_plexer.d.ts" */
import * as bg from "./result/wasm_plexer_bg.js";
import { __wbg_set_wasm } from "./result/wasm_plexer_bg.js";

let initPromise = null;

/** Idempotent: subsequent calls return the same promise. */
export function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const wasmUrl = new URL("./result/wasm_plexer_bg.wasm", import.meta.url);
    const response = await fetch(wasmUrl);
    const wasmBytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
      "./wasm_plexer_bg.js": bg,
    });
    __wbg_set_wasm(instance.exports);
    const start = instance.exports.__wbindgen_start;
    if (typeof start === "function") start();
  })();
  return initPromise;
}

export {
  FramingError,
  MultiplexerBuffer,
  unwrap_multiplexer_message,
  wrap_multiplexer_message,
} from "./result/wasm_plexer_bg.js";
