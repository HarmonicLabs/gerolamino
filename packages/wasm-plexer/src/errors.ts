import { Schema } from "effect";

import { FramingError as WasmFramingError } from "../result/wasm_plexer.js";

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

export const fromWasmError = (operation: FramingOperation, err: unknown): FramingOpError => {
  if (err instanceof WasmFramingError) {
    const code = err.code;
    const kind = CODE_TO_KIND.get(code) ?? "Unknown";
    return new FramingOpError({
      operation,
      kind,
      code,
      message: err.message,
    });
  }
  return new FramingOpError({
    operation,
    kind: "Unknown",
    code: 0,
    message: err instanceof Error ? err.message : String(err),
  });
};
