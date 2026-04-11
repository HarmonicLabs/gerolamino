/**
 * RPC Server — background service worker implements the Node RPC endpoints.
 *
 * Handles requests from the popup via Effect RPC over chrome.runtime.Port.
 * StreamSyncState uses a Queue to push state updates as they happen.
 *
 * State is managed via SyncStateRef — a shared Effect Service used by both
 * the RPC handlers and the bootstrap/genesis sync pipelines.
 */
import { Effect, Layer, Stream } from "effect";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { NodeRpcs } from "./rpc.ts";
import { SyncStateRef } from "./sync-state.ts";
import { bootstrapSyncPipeline } from "./bootstrap-sync.ts";
import { layerServerProtocolChromePort } from "./rpc-transport.ts";

// Re-export for consumers
export { SyncStateRef } from "./sync-state.ts";

// ---------------------------------------------------------------------------
// RPC handler layer for NodeRpcs.
// ---------------------------------------------------------------------------

export const NodeRpcHandlers = NodeRpcs.toLayer(
  Effect.gen(function* () {
    const syncState = yield* SyncStateRef;

    return NodeRpcs.of({
      GetSyncState: () => syncState.get,

      StartSync: () =>
        Effect.gen(function* () {
          yield* syncState.update({ status: "connecting" });

          // Fork the sync pipeline — runs in background
          yield* Effect.forkDetach(
            bootstrapSyncPipeline.pipe(
              Effect.tapError((err) =>
                syncState.update({ status: "error", lastError: String(err) }),
              ),
            ),
          );

          return { ok: true };
        }),

      StreamSyncState: () => Stream.unwrap(
        Effect.map(syncState.subscribe, Stream.fromQueue),
      ),
    });
  }),
);

// ---------------------------------------------------------------------------
// Full RPC server layer for the background service worker.
// ---------------------------------------------------------------------------

/**
 * Composes:
 * - NodeRpcHandlers (GetSyncState, StartSync, StreamSyncState)
 * - Chrome runtime Port protocol (popup ↔ background)
 *
 * NOTE: Does NOT include SyncStateRef.Live — the caller must provide it
 * so the same instance is shared with the sync pipeline.
 */
export const RpcServerLive = RpcServer.layer(NodeRpcs, {
  disableFatalDefects: true,
}).pipe(
  Layer.provide(NodeRpcHandlers),
  Layer.provide(layerServerProtocolChromePort),
);
