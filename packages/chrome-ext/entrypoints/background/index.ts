/**
 * Background service worker — Gerolamino in-browser Cardano node.
 *
 * Communication with popup uses Effect RPC over chrome.runtime.Port for
 * typed, schema-validated messaging. The RPC server handles:
 *   - GetSyncState: returns current sync state
 *   - StartSync: kicks off bootstrap sync pipeline
 *   - StreamSyncState: pushes state updates as they happen
 *
 * Sync strategy: bootstrap from production server, then relay sync via
 * the server's TCP proxy on the same WebSocket connection.
 *
 * All state flows through SyncStateRef — a single shared service that pushes
 * updates to both RPC streaming subscribers (popup) and chrome.storage.session
 * (non-RPC consumers).
 *
 * Keepalive: Chrome MV3 service workers are terminated after 30s of inactivity.
 * A chrome.alarms-based keepalive fires every minute to prevent termination
 * during long-running bootstrap downloads.
 */
import { Clock, Effect, Layer } from "effect";
import { INITIAL_STATE, SyncState } from "./rpc.ts";
import { RpcServerLive } from "./rpc-server.ts";
import { SyncStateRef } from "./sync-state.ts";
import { bootstrapSyncWithStateUpdates } from "./bootstrap-sync.ts";

// ---------------------------------------------------------------------------
// Chrome MV3 Service Worker Keepalive
// ---------------------------------------------------------------------------

/** Periodic alarm prevents Chrome from killing the SW during bootstrap. */
const KEEPALIVE_ALARM = "gerolamino-keepalive";

function setupKeepalive() {
  globalThis.chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  globalThis.chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) {
      // Alarm handler resets Chrome's 30-second idle timer.
      // No work needed — just firing the event keeps the SW alive.
    }
  });
}

// ---------------------------------------------------------------------------
// Service Worker Entry Point
// ---------------------------------------------------------------------------

export default defineBackground({
  type: "module",

  main() {
    // Start keepalive immediately — before any async work
    setupKeepalive();

    // Single Effect runtime — RPC server + sync pipeline share SyncStateRef.
    // Layer.launch keeps the RPC server alive; forkDetach runs the sync pipeline
    // concurrently within the same scope so both access the same state.
    Effect.gen(function* () {
      yield* Effect.log("[gerolamino] Background service worker started");
      yield* Effect.log(
        `[gerolamino] chrome.alarms keepalive registered (${KEEPALIVE_ALARM}, 30s interval)`,
      );

      // Set initial state with real timestamp from Effect Clock
      const now = yield* Clock.currentTimeMillis;
      const initialState = new SyncState({ ...INITIAL_STATE, lastUpdated: now });
      yield* Effect.promise(() =>
        globalThis.chrome.storage.session.set({ syncState: initialState }),
      );
      yield* Effect.log("[gerolamino] Initial SyncState persisted to chrome.storage.session");

      // Launch RPC server in background (keeps running)
      yield* Effect.log("[gerolamino] Launching RPC server (chrome.runtime.Port transport)");
      yield* Effect.forkDetach(Layer.launch(RpcServerLive));

      // Auto-start bootstrap sync pipeline (bootstrap runs once; relay retries internally)
      yield* Effect.log("[gerolamino] Auto-starting bootstrap sync pipeline");
      yield* bootstrapSyncWithStateUpdates.pipe(
        Effect.tapError((err) =>
          Effect.gen(function* () {
            yield* Effect.logError(`[gerolamino] Sync error: ${err}`);
            const syncState = yield* SyncStateRef;
            yield* syncState.update({ status: "error", lastError: String(err) });
          }),
        ),
        // Catch defects (Layer.orDie, Effect.die) so they're visible
        Effect.catchDefect((defect) =>
          Effect.gen(function* () {
            const msg = defect instanceof Error ? defect.message : String(defect);
            yield* Effect.logError(`[gerolamino] Sync defect: ${msg}`);
            const syncState = yield* SyncStateRef;
            yield* syncState.update({ status: "error", lastError: msg });
            return yield* Effect.fail(defect);
          }),
        ),
      );
    }).pipe(Effect.provide(SyncStateRef.Live), Effect.runFork);
  },
});
