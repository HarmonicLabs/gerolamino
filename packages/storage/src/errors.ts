/**
 * Storage error types — one per service component.
 */
import { Data } from "effect";

export class ImmutableDBError extends Data.TaggedError("ImmutableDBError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class VolatileDBError extends Data.TaggedError("VolatileDBError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class LedgerDBError extends Data.TaggedError("LedgerDBError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class MempoolError extends Data.TaggedError("MempoolError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class ChainDBError extends Data.TaggedError("ChainDBError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type StorageError =
  | ImmutableDBError
  | VolatileDBError
  | LedgerDBError
  | MempoolError
  | ChainDBError;
