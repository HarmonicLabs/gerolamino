import { Effect } from "effect";

import init from "../pkg/wasm_utils.js";

/**
 * WASM instantiation effect. wasm-bindgen's default export auto-locates
 * `wasm_utils_bg.wasm` via `import.meta.url`. Meant to be yielded inside a
 * `Layer.effect` body so Layer memoization enforces once-per-layer execution.
 */
export const initWasm: Effect.Effect<void> = Effect.promise(() => init()).pipe(Effect.asVoid);
