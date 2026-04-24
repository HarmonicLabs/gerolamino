/**
 * Storage error types — one per service component.
 *
 * `operation` is narrowed to a `Schema.Literals` enum of the actual ops the
 * service exposes. `Schema.String` was accepting any string and degrading
 * the `_tag` into an unhelpful free-form discriminator; enumerating the ops
 * lets `Effect.catchTag("X", (e) => Match.value(e.operation)).pipe(...)`
 * narrow exhaustively.
 */
import { Schema } from "effect";

export const ImmutableDBOperation = Schema.Literals([
  "streamBlocks",
  "writeBlocks",
  "readBlock",
  "getTip",
]);

export class ImmutableDBError extends Schema.TaggedErrorClass<ImmutableDBError>()(
  "ImmutableDBError",
  {
    operation: ImmutableDBOperation,
    cause: Schema.Defect,
  },
) {}

export const VolatileDBOperation = Schema.Literals([
  "writeBlocks",
  "readBlock",
  "getSuccessors",
  "garbageCollect",
]);

export class VolatileDBError extends Schema.TaggedErrorClass<VolatileDBError>()("VolatileDBError", {
  operation: VolatileDBOperation,
  cause: Schema.Defect,
}) {}

export const LedgerDBOperation = Schema.Literals(["writeSnapshot", "readLatestSnapshot"]);

export class LedgerDBError extends Schema.TaggedErrorClass<LedgerDBError>()("LedgerDBError", {
  operation: LedgerDBOperation,
  cause: Schema.Defect,
}) {}

// MempoolError in this package uses `message`, not `operation` — see
// `packages/consensus/src/mempool/mempool.ts` for the consensus-side
// instance. The storage-side stub is kept for cross-package typing
// compatibility; `operation` narrows to the literal set of ops the
// storage-side mempool surface exposes.
export const MempoolOperation = Schema.Literals(["submit", "snapshot", "remove", "validate"]);

export class MempoolError extends Schema.TaggedErrorClass<MempoolError>()("MempoolError", {
  operation: MempoolOperation,
  cause: Schema.Defect,
}) {}

export type StorageError = ImmutableDBError | VolatileDBError | LedgerDBError | MempoolError;
