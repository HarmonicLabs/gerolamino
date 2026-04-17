/**
 * TLV codec for Gerolamo bootstrap streaming.
 *
 * Provides `decodeStream` — a Stream combinator that reassembles TLV frames
 * from raw byte chunks and decodes them into typed BootstrapMessages.
 * Uses Stream.mapAccum for stateful frame accumulation (same pattern as
 * Effect v4's Channel.mapAccum / Msgpack codec, but at the Stream level).
 */
import { Schema, Stream } from "effect";
import * as Transformation from "effect/SchemaTransformation";
import {
  type BootstrapMessageType,
  BootstrapMessage,
  concatBytes,
  extractFrames,
  decodeFrame,
  encodeMessage,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Stream combinator: raw bytes → decoded BootstrapMessages
// Uses Stream.mapAccum for stateful TLV frame reassembly + decode.
// ---------------------------------------------------------------------------

export const decodeStream = <E, R>(
  self: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<BootstrapMessageType, E, R> =>
  self.pipe(
    Stream.mapAccum(
      (): Uint8Array => new Uint8Array(0),
      (buffer, chunk: Uint8Array) => {
        const combined = concatBytes(buffer, chunk);
        const { frames, remaining } = extractFrames(combined);
        return [remaining, frames.map(decodeFrame)] as const;
      },
    ),
  );

// ---------------------------------------------------------------------------
// Schema transformation: Uint8Array (complete frame) ↔ BootstrapMessageType
// ---------------------------------------------------------------------------

export const transformation = Transformation.transform<BootstrapMessageType, Uint8Array>({
  decode: decodeFrame,
  encode: encodeMessage,
});

export const schema = Schema.Uint8Array.pipe(Schema.decodeTo(BootstrapMessage, transformation));
