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
 */
import { Clock, Effect, Layer, Schedule } from "effect";
import { SyncState } from "./rpc.ts";
import { RpcServerLive } from "./rpc-server.ts";
import { SyncStateRef } from "./sync-state.ts";
import { bootstrapSyncWithStateUpdates } from "./bootstrap-sync.ts";

// ---------------------------------------------------------------------------
// Service Worker Entry Point
// ---------------------------------------------------------------------------

export default defineBackground({
  type: "module",

  main() {
    // Single Effect runtime — RPC server + sync pipeline share SyncStateRef.
    // Layer.launch keeps the RPC server alive; forkDetach runs the sync pipeline
    // concurrently within the same scope so both access the same state.
    const main = Effect.gen(function* () {
      yield* Effect.log("[gerolamino] Background service worker started");

      // Set initial state with real timestamp from Effect Clock
      const now = yield* Clock.currentTimeMillis;
      const initialState = new SyncState({
        status: "idle",
        protocolMagic: 0,
        snapshotSlot: "0",
        totalChunks: 0,
        totalBlobEntries: 0,
        blocksReceived: 0,
        blobEntriesReceived: 0,
        ledgerStateReceived: false,
        bootstrapComplete: false,
        lastUpdated: now,
      });
      yield* Effect.promise(() =>
        globalThis.chrome.storage.session.set({ syncState: initialState }),
      );

      // Launch RPC server in background (keeps running)
      yield* Effect.forkDetach(Layer.launch(RpcServerLive));

      // Auto-start bootstrap sync pipeline
      yield* Effect.retry(
        bootstrapSyncWithStateUpdates.pipe(
          Effect.tapError((err) =>
            Effect.gen(function* () {
              yield* Effect.logError(`[gerolamino] Sync error: ${err}`);
              const syncState = yield* SyncStateRef;
              yield* syncState.update({ status: "error", lastError: String(err) });
            }),
          ),
          // Catch defects (Layer.orDie, Effect.die) so they're visible + retryable
          Effect.catchDefect((defect) =>
            Effect.gen(function* () {
              const msg = defect instanceof Error ? defect.message : String(defect);
              yield* Effect.logError(`[gerolamino] Sync defect: ${msg}`);
              const syncState = yield* SyncStateRef;
              yield* syncState.update({ status: "error", lastError: msg });
              return yield* Effect.fail(defect);
            }),
          ),
        ),
        Schedule.exponential("5 seconds", 2).pipe(Schedule.take(5)),
      );
    }).pipe(Effect.provide(SyncStateRef.Live));

    Effect.runFork(main);
  },
});
