/**
 * Effect.Metric instrumentation for the chrome-ext offscreen pipeline.
 *
 * All meters are namespaced under `gerolamino.chrome_ext.*`. Counters use
 * `Metric.counter` (monotonic); gauges use `Metric.gauge` (set-from-effect);
 * histograms use `Metric.histogram` over linear boundaries appropriate for
 * each timing distribution.
 *
 * Wire-up points (see `bootstrap-sync.ts`):
 *   - WASM init success/fail: `wasmInitSuccess` / `wasmInitFailure`
 *   - WebSocket lifecycle: `wsConnect` / `wsDisconnect` / `wsRetry`
 *   - Bootstrap phase transitions: `bootstrapPhaseTransitions` (frequency)
 *   - Chain state: `tipSlot` / `syncPercent` / `peerCount` gauges
 *   - Block ingest rate: `blocksProcessed` counter
 *   - OPFS ingest outcome: `opfsIngestSuccess` / `opfsIngestFallback`
 *
 * Read via `Effect.runPromise(Metric.value(Metric.counter(...)))` from a
 * dev-tools or popup debug panel, or scrape via `Metric.snapshot` from
 * the offscreen RPC server for dashboard-side display.
 */
import { Metric } from "effect";

// ---------------------------------------------------------------------
// WASM initialisation
// ---------------------------------------------------------------------
export const wasmInitSuccess = Metric.counter("gerolamino.chrome_ext.wasm_init.success", {
  description: "Count of successful WASM module initialisations (wasm-utils + wasm-plexer).",
  incremental: true,
});

export const wasmInitFailure = Metric.counter("gerolamino.chrome_ext.wasm_init.failure", {
  description: "Count of WASM module init failures.",
  incremental: true,
});

export const wasmInitLatencyMs = Metric.timer(
  "gerolamino.chrome_ext.wasm_init.latency_ms",
  {
    description: "Latency (ms) of WASM init (wasm-utils + wasm-plexer composed).",
    boundaries: Metric.linearBoundaries({ start: 100, width: 100, count: 12 }),
  },
);

// ---------------------------------------------------------------------
// WebSocket lifecycle
// ---------------------------------------------------------------------
export const wsConnect = Metric.counter("gerolamino.chrome_ext.ws.connect", {
  description: "Successful WebSocket connections to the relay proxy.",
  incremental: true,
});

export const wsDisconnect = Metric.counter("gerolamino.chrome_ext.ws.disconnect", {
  description: "WebSocket scope closures (clean or otherwise).",
  incremental: true,
});

export const wsRetry = Metric.counter("gerolamino.chrome_ext.ws.retry", {
  description: "Outer-loop reconnect attempts via Schedule.exponential.",
  incremental: true,
});

// ---------------------------------------------------------------------
// Bootstrap / sync phase
// ---------------------------------------------------------------------
export const bootstrapPhaseTransitions = Metric.frequency(
  "gerolamino.chrome_ext.bootstrap.phase",
  {
    description: "Frequency by phase label (awaiting-ledger-state | complete | etc.).",
  },
);

export const opfsIngestSuccess = Metric.counter("gerolamino.chrome_ext.opfs_ingest.success", {
  description: "OPFS-mounted Mithril snapshot was found + decoded.",
  incremental: true,
});

export const opfsIngestFallback = Metric.counter("gerolamino.chrome_ext.opfs_ingest.fallback", {
  description: "OPFS ingest failed/missing — pipeline fell back to genesis LedgerView.",
  incremental: true,
});

// ---------------------------------------------------------------------
// Chain state gauges (mirror the live node state for dashboard scraping)
// ---------------------------------------------------------------------
export const tipSlot = Metric.gauge("gerolamino.chrome_ext.chain.tip_slot", {
  description: "Highest tip slot observed by the offscreen consensus driver.",
  bigint: true,
});

export const syncPercent = Metric.gauge("gerolamino.chrome_ext.chain.sync_percent", {
  description: "Sync-to-tip percentage (0–100).",
});

export const peerCount = Metric.gauge("gerolamino.chrome_ext.chain.peer_count", {
  description: "Currently-connected peer count (mirrors PeerManager.getPeers().length).",
});

export const epochNumber = Metric.gauge("gerolamino.chrome_ext.chain.epoch_number", {
  description: "Current chain epoch (mirrors NodeStatus.epochNumber).",
  bigint: true,
});

export const blocksProcessed = Metric.counter("gerolamino.chrome_ext.chain.blocks_processed", {
  description: "Monotonic block-ingest counter from the consensus driver.",
  incremental: true,
});
