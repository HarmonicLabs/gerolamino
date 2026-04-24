import { Schema } from "effect";

/**
 * Typed reasons for a decode failure. Replaces the prior free-form
 * `cause: Schema.Defect`; consumers can `Effect.catchTag("CborDecodeError",
 * e => Match.value(e.reason))` and handle specific failure modes
 * (truncation, malformed headers, narrow-helper mismatches, walker-time
 * schema bugs) distinctly.
 */
export const CborDecodeReason = Schema.Union([
  Schema.TaggedStruct("Truncated", {
    at: Schema.Number,
    needed: Schema.Number,
    available: Schema.Number,
  }),
  Schema.TaggedStruct("MalformedHeader", {
    at: Schema.Number,
    addInfos: Schema.optional(Schema.Number),
    majorType: Schema.optional(Schema.Number),
    message: Schema.String,
  }),
  Schema.TaggedStruct("NarrowMismatch", {
    expectedKind: Schema.Number,
    gotTag: Schema.Number,
    label: Schema.optional(Schema.String),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type CborDecodeReason = typeof CborDecodeReason.Type;

export const CborDecodeOperation = Schema.Literals(["parse", "skip", "narrow"]);
export type CborDecodeOperation = typeof CborDecodeOperation.Type;

export class CborDecodeError extends Schema.TaggedErrorClass<CborDecodeError>()("CborDecodeError", {
  operation: Schema.optional(CborDecodeOperation),
  reason: Schema.optional(CborDecodeReason),
  cause: Schema.optional(Schema.Defect),
}) {}

/** Typed reasons for an encode failure. */
export const CborEncodeReason = Schema.Union([
  Schema.TaggedStruct("CapacityExceeded", {
    needed: Schema.Number,
    cap: Schema.Number,
  }),
  Schema.TaggedStruct("IllFormedUtf16", {
    preview: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type CborEncodeReason = typeof CborEncodeReason.Type;

export class CborEncodeError extends Schema.TaggedErrorClass<CborEncodeError>()("CborEncodeError", {
  reason: Schema.optional(CborEncodeReason),
  cause: Schema.optional(Schema.Defect),
}) {}

/**
 * Typed error for schema-derivation bugs — fired at module load time by
 * the walker factories (`taggedUnionLink`, `sparseMapLink`,
 * `positionalArrayLink`, etc.) when the caller's Schema can't be mapped
 * to a CBOR link. These are schema-author errors (like TypeScript compile
 * errors), not runtime failures, so they stay as synchronous throws;
 * the typed class just carries structured debug info instead of a
 * stringified `Error`.
 */
export const CborDerivationLink = Schema.Literals([
  "taggedUnionLink",
  "sparseMapLink",
  "cborTaggedLink",
  "cborInCborLink",
  "positionalArrayLink",
  "objectsWalker",
  "literalEncoder",
]);
export type CborDerivationLink = typeof CborDerivationLink.Type;

export class CborDerivationError extends Schema.TaggedErrorClass<CborDerivationError>()(
  "CborDerivationError",
  {
    link: CborDerivationLink,
    astTag: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
