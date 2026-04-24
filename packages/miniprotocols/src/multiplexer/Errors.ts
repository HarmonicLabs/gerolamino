import { Schema } from "effect";
import { ProcessedFrameSchema } from "./Schemas";

/**
 * Multiplexer error types. Each `operation` field is narrowed to the
 * enum of actual ops the multiplexer exposes so consumers can
 * `Match.value(e.operation)` without defaulting to a string pattern.
 */
export const MultiplexerHeaderOperation = Schema.Literals(["Decode frames"]);

export class MultiplexerHeaderError extends Schema.TaggedErrorClass<MultiplexerHeaderError>()(
  "MultiplexerHeaderError",
  {
    operation: MultiplexerHeaderOperation,
    data: Schema.TaggedUnion({
      Parsed: { frame: ProcessedFrameSchema },
      Raw: { raw: Schema.Uint8Array },
    }),
    cause: Schema.Defect,
  },
) {}

export const MultiplexerEncodingOperation = Schema.Literals(["Frame wrapping"]);

export class MultiplexerEncodingError extends Schema.TaggedErrorClass<MultiplexerEncodingError>()(
  "MultiplexerEncodingError",
  {
    operation: MultiplexerEncodingOperation,
    payload: Schema.Uint8Array,
    protocol: Schema.Number,
    cause: Schema.Defect,
  },
) {}

export type MultiplexerAuxError = MultiplexerHeaderError | MultiplexerEncodingError;

/**
 * Multiplexer error types
 */
export class MultiplexerConnectionError extends Schema.TaggedErrorClass<MultiplexerConnectionError>()(
  "MultiplexerConnectionError",
  {
    protocolType: Schema.String,
    attempt: Schema.Number,
    cause: Schema.Defect,
  },
) {}

/** Reserved for future mini-protocol-level faults. No current construction
 * sites — the literal set is provisional and should be widened when
 * protocol handlers start emitting this error. */
export const MultiplexerProtocolOperation = Schema.Literals([
  "send",
  "receive",
  "decode",
  "encode",
]);

export class MultiplexerProtocolError extends Schema.TaggedErrorClass<MultiplexerProtocolError>()(
  "MultiplexerProtocolError",
  {
    protocolId: Schema.Number,
    operation: MultiplexerProtocolOperation,
    cause: Schema.Defect,
  },
) {}

export class MultiplexerFrameError extends Schema.TaggedErrorClass<MultiplexerFrameError>()(
  "MultiplexerFrameError",
  {
    frameType: Schema.String,
    frameData: Schema.Uint8Array,
    cause: Schema.Defect,
  },
) {}

export class MultiplexerBufferError extends Schema.TaggedErrorClass<MultiplexerBufferError>()(
  "MultiplexerBufferError",
  {
    cause: Schema.Defect,
  },
) {}

export type MultiplexerError =
  | MultiplexerConnectionError
  | MultiplexerProtocolError
  | MultiplexerFrameError
  | MultiplexerBufferError
  | MultiplexerAuxError;
