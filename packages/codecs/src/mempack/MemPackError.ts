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
