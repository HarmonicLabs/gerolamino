/**
 * BlockSync Workflow — durable orchestrator for genesis→tip block sync.
 *
 * Phase 3f scaffolding: the `Workflow.make` declaration + idempotency key
 * wiring. The `toLayer` handler is stubbed because it depends on consumers
 * that haven't landed yet (peer Cluster Entity, ChainDb validation loop,
 * SyncStage pipeline composition). Concrete handler lives with Phase 3f
 * proper — this file exists so downstream code can import `BlockSyncWorkflow`
 * and test the contract.
 *
 * Keyed on `chainId` per plan §3 Workflow Tier-1: one BlockSync execution
 * per chain, so a re-fire against the same chain returns the cached result
 * instead of duplicating the sync.
 *
 * Suspended retry schedule: `Schedule.exponential(1000, 1.2)` — wraps
 * transient peer failures per plan Phase 3f (plan's recommended cadence).
 *
 * Execution model (for future handler implementation — plan §3 arch note):
 *   - Activities set up peer fibers + ChainDb worker (cached Activity results
 *     short-circuit on re-entry)
 *   - One long `DurableDeferred.await` for the "synced" signal
 *   - SyncStage pipeline composed via `runStage`/`connect` inside ChainDb
 *     worker — NOT as Workflow Activities (per wave-2 correction: ChainDb
 *     is a sequential addBlockRunner in Haskell; the pipeline is gerolamino's
 *     departure, safe because LedgerApplyStage is single-fiber)
 */
import { Schedule, Schema } from "effect";
import * as Workflow from "effect/unstable/workflow/Workflow";

/**
 * `Point` — chain tip reference (slot + hash).
 *
 * Shared with `chain/event-log`'s `RollbackTarget.RealPoint`; future
 * refactor can hoist into a single package-level type.
 */
export const Point = Schema.Struct({
  slot: Schema.BigInt,
  hash: Schema.Uint8Array,
});
export type PointT = typeof Point.Type;

/** Failure reasons a BlockSync workflow can terminate with. */
export const BlockSyncError = Schema.Union([
  Schema.TaggedStruct("NoPeersReachable", {
    chainId: Schema.String,
    attempts: Schema.Number,
  }),
  Schema.TaggedStruct("HeaderValidationFailed", {
    slot: Schema.BigInt,
    reason: Schema.String,
  }),
  Schema.TaggedStruct("RollbackExceededK", {
    depth: Schema.Number,
    k: Schema.Number,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type BlockSyncErrorT = typeof BlockSyncError.Type;

export const BlockSyncSuccess = Schema.Struct({
  tipSlot: Schema.BigInt,
  tipHash: Schema.Uint8Array,
  blocksProcessed: Schema.Number,
});
export type BlockSyncSuccessT = typeof BlockSyncSuccess.Type;

/**
 * The BlockSync Workflow contract. Consumers:
 *   - `apps/bootstrap` — fires `BlockSyncWorkflow.execute({ chainId,
 *     fromSlot })` at server start to replay through connected peers
 *   - `apps/tui` — fires per-network on CLI start, polls via
 *     `BlockSyncWorkflow.poll` for live tip updates
 *
 * Execution is durable via the Workflow engine (sqlite on bootstrap,
 * memory on tui — consumer-scoped Layer). Idempotency-keyed on `chainId`
 * so concurrent triggers collapse to one run.
 */
export const BlockSyncWorkflow = Workflow.make({
  name: "BlockSync",
  payload: {
    chainId: Schema.String,
    fromSlot: Schema.BigInt,
  },
  success: BlockSyncSuccess,
  error: BlockSyncError,
  idempotencyKey: ({ chainId }) => chainId,
  suspendedRetrySchedule: Schedule.exponential("1 seconds", 1.2),
});
