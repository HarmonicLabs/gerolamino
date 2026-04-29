/**
 * Tunable constants for the TUI process.
 *
 * Pulled into one file so cadence / size knobs aren't scattered as
 * inline literals across `index.ts` and `dashboard/webview.ts`.
 */

/** Log a "UTxO entries received" line every N entries during bootstrap. */
export const UTXO_LOG_INTERVAL = 50_000;

/** Log a "Blocks received" line every N blocks during bootstrap. */
export const BLOCK_LOG_INTERVAL = 10_000;

/** `Bun.WebView` viewport defaults. The webview is headless on Linux/macOS
 *  alike (Bun does not yet expose `headless: false`) — these dimensions
 *  define the page's logical viewport for CSS / layout calculations. */
export const WEBVIEW_DEFAULT_WIDTH = 1280;
export const WEBVIEW_DEFAULT_HEIGHT = 800;

/** HTTP + WebSocket port the TUI hosts the dashboard SPA on. Browsers
 *  navigate to `http://localhost:DASHBOARD_PORT/`, which serves the
 *  static bundle and upgrades `/ws` to a WebSocket that broadcasts
 *  atom-state deltas. Replaces the prior Bun.WebView-only render path
 *  (headless-only on Linux, so no visible viewer existed). */
export const DASHBOARD_PORT = 3041;

/** Delta-push fiber cadence — 10Hz. Empirically the highest rate at which
 *  the relay-sync loop and the CDP `evaluate()` IPC don't contend for the
 *  Bun main thread: at 60Hz, the per-tick `JSON.stringify` of the full
 *  dashboard atom tree (chainEventLog at 1000 entries dominates) plus the
 *  pipe-bound `view.evaluate` round trip starves the consensus driver to
 *  zero blocks. 10Hz still feels live for a sync dashboard — the
 *  underlying atoms tick at 1Hz (monitor loop) and per-block (chain
 *  events), so anything faster oversamples. `view.evaluate` is
 *  single-in-flight, so the per-tick wait is also the per-evaluate wait
 *  under steady-state load. */
export const DELTA_PUSH_INTERVAL_MS = 100;

/** Dashboard monitor loop cadence. The sparkline atom expects 1 Hz samples
 *  for its 10-min sliding window; `getNodeStatus` is cheap (in-memory
 *  ChainDB tip + slot clock + peer count) so 1s polling is well under any
 *  CPU budget. */
export const MONITOR_LOOP_INTERVAL = "1 second" as const;

/** Headless-mode structured-log dump cadence. Dumps every 10 seconds —
 *  granular enough for CI / E2E inspection without flooding logs. */
export const HEADLESS_LOG_INTERVAL = "10 seconds" as const;

/** Monitor-loop retry spacing on transient failures. Uncapped (vs the
 *  prior `Schedule.during("60 seconds")`) so a long-running TUI session
 *  never permanently abandons dashboard updates after a flake. */
export const MONITOR_RETRY_SPACING = "5 seconds" as const;
