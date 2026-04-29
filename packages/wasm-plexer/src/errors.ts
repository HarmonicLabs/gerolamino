import { Schema } from "effect";

// Goes through `./wasm-init.ts` so the bg.js class methods that touch
// `wasm.something()` (e.g. `FramingError.code` / `.message` getters)
// always observe a live, instantiated module.
import { FramingError as WasmFramingError } from "./wasm-init.ts";

export const FramingErrorKind = Schema.Literals([
  "ShortFrame",
  "IncompletePayload",
  "InvalidProtocol",
  "Unknown",
]);
export type FramingErrorKind = typeof FramingErrorKind.Type;

/** Enumerates the wasm-plexer `Service` ops — narrows `operation` from a
 * free-form string so TS catches typos at the `fromWasmError(...)` call site. */
export const FramingOperation = Schema.Literals([
  "FrameBuffer.append",
  "FrameBuffer.drain",
  "FrameBuffer.size",
  "MuxFraming.wrapFrame",
  "MuxFraming.unwrapFrame",
]);
export type FramingOperation = typeof FramingOperation.Type;

const CODE_TO_KIND: ReadonlyMap<number, FramingErrorKind> = new Map([
  [1, "ShortFrame"],
  [2, "IncompletePayload"],
  [3, "InvalidProtocol"],
]);

export class FramingOpError extends Schema.TaggedErrorClass<FramingOpError>()(
  "wasm-plexer/FramingOpError",
  {
    operation: FramingOperation,
    kind: FramingErrorKind,
    code: Schema.Number,
    message: Schema.String,
  },
) {}

/** Schema for the wasm-bindgen `FramingError` instance shape. The bg.js
 *  shim doesn't ship a typed export, and `instanceof WasmFramingError`
 *  doesn't narrow through the `@ts-self-types` re-export chain — so we
 *  decode unknowns into this shape and read fields off the validated
 *  result, satisfying the project rule that bans `as Type` casts. */
const WasmFramingErrorShape = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
});
const decodeWasmFramingError = Schema.decodeUnknownOption(WasmFramingErrorShape);

export const fromWasmError = (operation: FramingOperation, err: unknown): FramingOpError => {
  if (err instanceof WasmFramingError) {
    const decoded = decodeWasmFramingError(err);
    if (decoded._tag === "Some") {
      const { code, message } = decoded.value;
      return new FramingOpError({
        operation,
        kind: CODE_TO_KIND.get(code) ?? "Unknown",
        code,
        message,
      });
    }
  }
  return new FramingOpError({
    operation,
    kind: "Unknown",
    code: 0,
    message: err instanceof Error ? err.message : String(err),
  });
};
