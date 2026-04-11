import { Schema } from "effect";
import { BlobStoreError } from "storage";

export class ChunkReadError extends Schema.TaggedErrorClass<ChunkReadError>()("ChunkReadError", {
  chunkNo: Schema.Number,
  cause: Schema.Defect,
}) {}

export type BootstrapError = BlobStoreError | ChunkReadError;
