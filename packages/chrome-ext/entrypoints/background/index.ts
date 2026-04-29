/**
 * Background service worker — Gerolamino in-browser Cardano node.
 *
 * Architecture mirrors `apps/tui` exactly: a single Effect program owns
 * the dashboard atom registry; a scoped fiber polls it every 100 ms,
 * builds a JSON delta, and publishes via `PubSub<string>`; every popup
 * connection consumes that PubSub via the `BroadcastDeltas` streaming
 * RPC over `chrome.runtime.Port`. Bootstrap + relay sync run in the same
 * scope so atom updates and broadcast share a fate.
 *
 * Keepalive: Chrome MV3 service workers are evicted after ~30 s of
 * inactivity. A `chrome.alarms` alarm fires every 30 s to reset the idle
 * timer during long-running bootstrap downloads. The alarm itself does
 * no work — its delivery is the keepalive.
 */
import { Effect, Layer } from "effect";
import { RpcServerLive } from "./rpc-server.ts";
import { DashboardBroadcast } from "./dashboard/broadcast.ts";
import { pushNodeState } from "./dashboard/atoms.ts";
import { bootstrapSyncWithStateUpdates } from "./bootstrap-sync.ts";

// ---------------------------------------------------------------------------
// Chrome MV3 Service Worker Keepalive
// ---------------------------------------------------------------------------

const KEEPALIVE_ALARM = "gerolamino-keepalive";

function setupKeepalive() {
  globalThis.chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  globalThis.chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) {
      // Alarm delivery resets Chrome's 30 s idle timer; no work needed.
    }
  });
}

// ---------------------------------------------------------------------------
// Service Worker Entry Point
// ---------------------------------------------------------------------------

export default defineBackground({
  type: "module",

  main() {
    setupKeepalive();

    // Layer composition: the broadcast PubSub + RPC server share the
    // dashboard atom registry (module-level singleton in
    // `dashboard/atoms.ts`). `Effect.provide` pulls in `DashboardBroadcast.Live`,
    // which spins up the PubSub + the broadcast fiber that publishes
    // delta JSON every `DELTA_PUSH_INTERVAL_MS` (see `dashboard/broadcast.ts`).
    const program = Effect.gen(function* () {
      yield* Effect.log("[gerolamino] Background service worker started");
      yield* Effect.log(
        `[gerolamino] chrome.alarms keepalive registered (${KEEPALIVE_ALARM}, 30s interval)`,
      );

      yield* Effect.log("[gerolamino] Launching RPC server (chrome.runtime.Port transport)");
      yield* Effect.forkDetach(Layer.launch(RpcServerLive));

      yield* Effect.log("[gerolamino] Auto-starting bootstrap sync pipeline");
      yield* bootstrapSyncWithStateUpdates.pipe(
        Effect.tapError((err) =>
          Effect.gen(function* () {
            yield* Effect.logError(`[gerolamino] Sync error: ${err}`);
            yield* pushNodeState({ status: "error", lastError: String(err) });
          }),
        ),
        Effect.catchDefect((defect) =>
          Effect.gen(function* () {
            const msg = defect instanceof Error ? defect.message : String(defect);
            yield* Effect.logError(`[gerolamino] Sync defect: ${msg}`);
            yield* pushNodeState({ status: "error", lastError: msg });
            return yield* Effect.fail(defect);
          }),
        ),
      );
    });

    // Provide layers explicitly, then run-fork. Piping `Effect.runFork`
    // through `.pipe(...)` confused tsgo's overload resolution because
    // the inner program's `R` channel inherits a residual `any` from
    // upstream packages — calling `runFork` as a function avoids the
    // overload mismatch.
    Effect.runFork(program.pipe(Effect.provide(DashboardBroadcast.Live)));
  },
});
