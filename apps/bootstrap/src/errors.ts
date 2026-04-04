import { Schema } from "effect";

export class LmdbError extends Schema.TaggedErrorClass<LmdbError>()("LmdbError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

export class ChunkReadError extends Schema.TaggedErrorClass<ChunkReadError>()("ChunkReadError", {
  chunkNo: Schema.Number,
  cause: Schema.Defect,
}) {}

export type BootstrapError = LmdbError | ChunkReadError;
