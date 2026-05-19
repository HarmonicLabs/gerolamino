/**
 * Typed errors for the `lsm-wasm` adapter.
 *
 * `LsmWasmError` is the single surface error every `LsmWasm` operation
 * lifts into. The `operation` field discriminates the failing step so
 * callers can `Match.value(e.operation)` exhaustively; `cause` carries
 * the underlying defect (a `WebAssembly.CompileError`, an `Error` from
 * the WASI host, or a string from a non-zero reactor return code).
 */
import { Schema } from "effect";

export const LsmWasmOperation = Schema.Literals([
  /** `WebAssembly.compile` on the supplied module bytes. */
  "compile",
  /** `WebAssembly.instantiate` against the JSFFI + WASI imports table. */
  "instantiate",
  /** Host-side `wasi.initialize(instance)` (reactor `_initialize` shim). */
  "wasiInitialize",
  /** `hs_init()` — boots the Haskell RTS. */
  "hsInit",
  /** A reactor export that the adapter expected to be present is missing
   *  or has the wrong shape (e.g. `memory` isn't a `WebAssembly.Memory`). */
  "exportMissing",
  /** `malloc` / `free` / `peekCStringLen` boundary for a string argument. */
  "stringMarshal",
  /** A `hs_lsm_*` reactor function returned a non-zero status code (i.e.
   *  the Haskell side handled an exception and surfaced it via stderr). */
  "reactorCall",
]);
export type LsmWasmOperation = typeof LsmWasmOperation.Type;

export class LsmWasmError extends Schema.TaggedErrorClass<LsmWasmError>()(
  "lsm-wasm/LsmWasmError",
  {
    operation: LsmWasmOperation,
    cause: Schema.Defect,
  },
) {}

/**
 * Pass-through lift for `Effect.try` / `Effect.tryPromise` catch
 * handlers. If the thrown cause is already an `LsmWasmError`, return
 * it unchanged so the throw site's `operation` tag is preserved.
 * Otherwise, wrap the unknown cause under the supplied `operation`
 * slot. Eliminates the double-wrap pattern where unconditional
 * `new LsmWasmError({ operation, cause })` would bury a typed inner
 * error in the `.cause` field, hiding its own operation tag.
 *
 * Use as the canonical catch handler:
 *
 * ```ts
 * Effect.tryPromise({
 *   try: () => doSomething(),
 *   catch: (cause) => liftLsmError("instantiate", cause),
 * });
 * ```
 */
export const liftLsmError = (operation: LsmWasmOperation, cause: unknown): LsmWasmError =>
  cause instanceof LsmWasmError ? cause : new LsmWasmError({ operation, cause });
