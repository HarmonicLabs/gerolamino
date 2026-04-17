import { Schema } from "effect";

export class CborDecodeError extends Schema.TaggedErrorClass<CborDecodeError>()("CborDecodeError", {
  cause: Schema.Defect,
}) {}

export class CborEncodeError extends Schema.TaggedErrorClass<CborEncodeError>()("CborEncodeError", {
  cause: Schema.Defect,
}) {}
