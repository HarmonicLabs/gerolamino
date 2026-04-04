import { Schema } from "effect";

export class ProtocolError extends Schema.TaggedErrorClass<ProtocolError>()("ProtocolError", {
  message: Schema.String,
}) {}
