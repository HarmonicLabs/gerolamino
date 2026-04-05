/**
 * Storage error types — one per service component.
 */
import { Schema } from "effect";

export class ImmutableDBError extends Schema.TaggedErrorClass<ImmutableDBError>()(
  "ImmutableDBError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class VolatileDBError extends Schema.TaggedErrorClass<VolatileDBError>()("VolatileDBError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

export class LedgerDBError extends Schema.TaggedErrorClass<LedgerDBError>()("LedgerDBError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

export class MempoolError extends Schema.TaggedErrorClass<MempoolError>()("MempoolError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

export class ChainDBError extends Schema.TaggedErrorClass<ChainDBError>()("ChainDBError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

export type StorageError =
  | ImmutableDBError
  | VolatileDBError
  | LedgerDBError
  | MempoolError
  | ChainDBError;
