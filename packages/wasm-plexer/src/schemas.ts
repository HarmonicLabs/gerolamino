import { Schema } from "effect";

/**
 * Ouroboros multiplexer wire-format frame — 8-byte header followed by
 * payload. Matches the `unwrap_multiplexer_message` return shape.
 */
export const WrappedFrame = Schema.Struct({
  transmissionTime: Schema.Number,
  hasAgency: Schema.Boolean,
  protocol: Schema.Number,
  payloadLength: Schema.Int,
  payload: Schema.Uint8Array,
});
export type WrappedFrame = typeof WrappedFrame.Type;

export const WrappedFrameArray = Schema.Array(WrappedFrame);
