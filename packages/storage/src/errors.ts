/**
 * Storage error types.
 *
 * `ChainDBError` and `LedgerSnapshotError` live with their respective
 * services in `services/`. Only the storage-side mempool stub remains
 * here — the canonical instance is in `packages/consensus`.
 */
import { Schema } from "effect";

export const MempoolOperation = Schema.Literals(["submit", "snapshot", "remove", "validate"]);

export class MempoolError extends Schema.TaggedErrorClass<MempoolError>()("MempoolError", {
  operation: MempoolOperation,
  cause: Schema.Defect,
}) {}
