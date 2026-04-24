import { Schema } from "effect";

export class MemPackDecodeError extends Schema.TaggedErrorClass<MemPackDecodeError>()(
  "MemPackDecodeError",
  {
    cause: Schema.Defect,
  },
) {}

export class MemPackEncodeError extends Schema.TaggedErrorClass<MemPackEncodeError>()(
  "MemPackEncodeError",
  {
    cause: Schema.Defect,
  },
) {}

/** Enumerates every walker factory + walk entry point that can raise a
 * derivation failure — schema bugs caught at `toCodecMemPack(schema)`
 * load time, not runtime decode. */
export const MemPackDerivationLink = Schema.Literals([
  "walkBase",
  "enumCodec",
  "arraysCodec",
  "unionCodec",
  "taggedUnionCodec",
]);
export type MemPackDerivationLink = typeof MemPackDerivationLink.Type;

/** Thrown at schema-derivation time when the walker can't build a codec
 * from the caller's Schema. Kept as synchronous `throw` (like a compile
 * error) rather than an Effect failure because it fires once at module
 * load, not per-decode. The typed class carries structured debug info. */
export class MemPackDerivationError extends Schema.TaggedErrorClass<MemPackDerivationError>()(
  "MemPackDerivationError",
  {
    link: MemPackDerivationLink,
    astTag: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
