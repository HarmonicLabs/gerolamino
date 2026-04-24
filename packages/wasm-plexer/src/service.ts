import { Context, Effect, Layer, Schema } from "effect";

import {
  MultiplexerBuffer as WasmMultiplexerBuffer,
  unwrap_multiplexer_message,
  wrap_multiplexer_message,
} from "../result/wasm_plexer.js";

import { FramingOpError, type FramingOperation, fromWasmError } from "./errors.ts";
import { WrappedFrame, WrappedFrameArray } from "./schemas.ts";

const decodeFrame = Schema.decodeUnknownEffect(WrappedFrame);
const decodeFrames = Schema.decodeUnknownEffect(WrappedFrameArray);

const toFramingError =
  (operation: FramingOperation) =>
  (cause: unknown): FramingOpError => {
    if (cause instanceof Object && "_tag" in cause && cause._tag === "SchemaError") {
      return new FramingOpError({
        operation,
        kind: "Unknown",
        code: 0,
        message: `schema decode failed: ${String(cause)}`,
      });
    }
    return fromWasmError(operation, cause);
  };

/**
 * Stateful frame accumulator — analogue of the Rust `MultiplexerBuffer`
 * but surfacing every fallible op through an `Effect` boundary.
 */
export class FrameBuffer extends Context.Service<
  FrameBuffer,
  {
    readonly append: (chunk: Uint8Array) => Effect.Effect<void, FramingOpError>;
    readonly drain: () => Effect.Effect<ReadonlyArray<WrappedFrame>, FramingOpError>;
    readonly size: () => Effect.Effect<number, FramingOpError>;
  }
>()("wasm-plexer/FrameBuffer") {}

export const FrameBufferLive: Layer.Layer<FrameBuffer> = Layer.effect(
  FrameBuffer,
  Effect.sync(() => {
    const wasmBuffer = new WasmMultiplexerBuffer();
    return {
      append: (chunk) =>
        Effect.try({
          try: () => wasmBuffer.append_chunk(chunk),
          catch: (err) => fromWasmError("FrameBuffer.append", err),
        }),
      drain: () =>
        Effect.try({
          try: () => wasmBuffer.process_frames(),
          catch: (err) => fromWasmError("FrameBuffer.drain", err),
        }).pipe(
          Effect.flatMap((raw) =>
            decodeFrames(raw).pipe(Effect.mapError(toFramingError("FrameBuffer.drain"))),
          ),
        ),
      size: () =>
        Effect.try({
          try: () => wasmBuffer.buffer_len(),
          catch: (err) => fromWasmError("FrameBuffer.size", err),
        }),
    };
  }),
);

/**
 * Stateless framing primitives — `wrapFrame` encodes, `unwrapFrame` decodes.
 * `unwrapFrame` is the fallible operation; `wrapFrame` is infallible in the
 * Rust implementation but the Effect signature allocates an error channel
 * so callers compose cleanly.
 */
export class MuxFraming extends Context.Service<
  MuxFraming,
  {
    readonly wrapFrame: (
      payload: Uint8Array,
      protocolId: number,
      hasAgency: boolean,
    ) => Effect.Effect<Uint8Array, FramingOpError>;
    readonly unwrapFrame: (message: Uint8Array) => Effect.Effect<WrappedFrame, FramingOpError>;
  }
>()("wasm-plexer/MuxFraming") {}

export const MuxFramingLive: Layer.Layer<MuxFraming> = Layer.succeed(MuxFraming, {
  wrapFrame: (payload, protocolId, hasAgency) =>
    Effect.try({
      try: () => wrap_multiplexer_message(payload, protocolId, hasAgency),
      catch: (err) => fromWasmError("MuxFraming.wrapFrame", err),
    }),
  unwrapFrame: (message) =>
    Effect.try({
      try: () => unwrap_multiplexer_message(message),
      catch: (err) => fromWasmError("MuxFraming.unwrapFrame", err),
    }).pipe(
      Effect.flatMap((raw) =>
        decodeFrame(raw).pipe(Effect.mapError(toFramingError("MuxFraming.unwrapFrame"))),
      ),
    ),
});
