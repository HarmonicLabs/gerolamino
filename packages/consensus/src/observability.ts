/**
 * Consensus-level Metric declarations + Logger factory.
 *
 * Phase 3g scaffolding: centralizes the Metric names so any stage / service
 * that wants to emit counters uses the same shared Meter registry. OTLP
 * export wiring lives in the app-level layer (apps/bootstrap's
 * `otlp-layer.ts` — deferred until peer Cluster + BlockSync Workflow
 * consumers are ready).
 *
 * Metric naming convention (matches `SyncStage.ts` `stageMetrics` helper):
 *   stage_<name>_in|out|err       counter
 *   stage_<name>_latency_ms        histogram
 *
 * Consensus-layer top-level metrics (not stage-scoped):
 *   consensus_chain_tip_slot       gauge       — current selected-chain tip
 *   consensus_chain_length         gauge       — current selected-chain length (blocks)
 *   consensus_peer_count           gauge       — active peer count
 *   consensus_rollback_count       counter     — incremented on each RolledBack event
 *   consensus_epoch_boundary_count counter     — incremented on each EpochBoundary event
 *   consensus_block_accepted       counter     — per-block accept tally
 *
 * Gauge semantics: monotonic updates via `Metric.update(gauge, value)`.
 * Counters: increment via `Metric.update(counter, 1)`.
 */
import { Metric } from "effect";

// ---------------------------------------------------------------------------
// Consensus top-level metrics
// ---------------------------------------------------------------------------

/** Current selected-chain tip slot. Updated on every `TipAdvanced`. */
export const ChainTipSlot = Metric.gauge("consensus_chain_tip_slot", { bigint: true });

/** Current selected-chain length (blocks). Monotonic except on deep rollback. */
export const ChainLength = Metric.gauge("consensus_chain_length", { bigint: true });

/** Active peer count. */
export const PeerCount = Metric.gauge("consensus_peer_count");

/** Rollback tally. Never decreases. */
export const RollbackCount = Metric.counter("consensus_rollback_count", { incremental: true });

/** Epoch-boundary crossings observed. */
export const EpochBoundaryCount = Metric.counter("consensus_epoch_boundary_count", {
  incremental: true,
});

/** Per-block accept tally. */
export const BlockAccepted = Metric.counter("consensus_block_accepted", { incremental: true });

/** Cumulative block validation failures (header or body). */
export const BlockValidationFailed = Metric.counter("consensus_block_validation_failed", {
  incremental: true,
});

/** Cumulative BlockFetch failures during relay sync. The relay loop
 *  treats these as best-effort (next block can still be processed
 *  without the body bytes); the counter surfaces the rate so an
 *  operator alert can fire on persistent upstream pathology. */
export const BlockFetchError = Metric.counter("consensus_block_fetch_error", {
  incremental: true,
});

/** Cumulative peers evicted for stall (past stall timeout). */
export const PeerStalledCount = Metric.counter("consensus_peer_stalled", { incremental: true });

/**
 * Per-block RollForward end-to-end latency (ms). Captures the full
 * driver path: header decode → 5-bucket Praos validation → block storage
 * → nonce evolution → chain-event emission. Bucket boundaries cover the
 * realistic spectrum (1 ms typical for Byron stub blocks, 10–100 ms for
 * Shelley+ on a worker-backed Crypto layer, 500+ ms only on a degraded
 * path). Histogram lets us alert on tail latency without per-block
 * stdout noise. */
export const RollForwardLatencyMs = Metric.histogram("consensus_roll_forward_latency_ms", {
  boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
});

// ---------------------------------------------------------------------------
// Span name helpers
// ---------------------------------------------------------------------------

/**
 * Standard span-name conventions for consensus operations. Pair with
 * `Effect.withSpan(SPAN.*)` so OTLP traces have a consistent hierarchy
 * across the consensus + storage boundary.
 *
 * Hierarchy:
 *   consensus.blocksync.*   — BlockSync Workflow Activities
 *   consensus.validate.*    — header / block body validation
 *   consensus.stage.*       — SyncStage pipeline stages (set by SyncStage.ts)
 *   consensus.chain.*       — chain-selection + ChainDb interactions
 *   consensus.peer.*        — peer-manager operations
 */
export const SPAN = {
  BlockSyncActivity: (name: string) => `consensus.blocksync.${name}`,
  ValidateHeader: "consensus.validate.header",
  ValidateBody: "consensus.validate.body",
  ChainSelect: "consensus.chain.select",
  ChainRollback: "consensus.chain.rollback",
  PromoteVolatile: "consensus.chain.promote_volatile",
  PeerConnect: "consensus.peer.connect",
  PeerDisconnect: "consensus.peer.disconnect",
  PeerStalled: "consensus.peer.stalled",
} as const;
