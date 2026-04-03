import { Data } from "effect"

export class LmdbError extends Data.TaggedError("LmdbError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export class ChunkReadError extends Data.TaggedError("ChunkReadError")<{
  readonly chunkNo: number
  readonly cause: unknown
}> {}

export type BootstrapError = LmdbError | ChunkReadError
