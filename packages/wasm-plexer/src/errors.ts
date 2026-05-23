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

const readWasmFramingFields = (
  err: unknown,
): { readonly code: number; readonly message: string } | undefined => {
  if (!(err instanceof WasmFramingError)) return undefined;
  const code = Reflect.get(Object(err), "code");
  const message = Reflect.get(Object(err), "message");
  if (typeof code !== "number" || typeof message !== "string") return undefined;
  return { code, message };
};

export const fromWasmError = (operation: FramingOperation, err: unknown): FramingOpError => {
  // wasm-bindgen exposes `code` / `message` as prototype getters — only
  // `__wbg_ptr` is an own property, so `Schema.decodeUnknown` cannot see
  // them. `instanceof` + Reflect reads avoid `unknown` narrowing gaps in tsgo.
  const fields = readWasmFramingFields(err);
  if (fields !== undefined) {
    return new FramingOpError({
      operation,
      kind: CODE_TO_KIND.get(fields.code) ?? "Unknown",
      code: fields.code,
      message: fields.message,
    });
  }
  return new FramingOpError({
    operation,
    kind: "Unknown",
    code: 0,
    message: err instanceof Error ? err.message : String(err),
  });
};
