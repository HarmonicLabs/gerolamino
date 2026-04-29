/**
 * RPC server — chrome-ext background service worker.
 *
 * `BroadcastDeltas` is the streaming endpoint that ships every popup
 * connection a `Stream.concat(initial, fromPubSub(broadcast))` — the
 * exact shape of `apps/tui/src/dashboard/serve.ts:54-67`'s WS handler,
 * just routed over `chrome.runtime.Port` instead of an upgraded
 * WebSocket. The PubSub itself is fed by the broadcast fiber in
 * `./dashboard/broadcast.ts`.
 *
 * `StartSync` forks the bootstrap pipeline. The SW also auto-starts the
 * pipeline on boot (`./index.ts`), so this endpoint is mostly a hook for
 * a future user-driven retry; the side effect is a fork + atom update.
 */
import { Effect, Layer, Stream } from "effect";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { buildDeltaJson } from "dashboard/delta";
import { NodeRpcs } from "./rpc.ts";
import { registry, pushNodeState } from "./dashboard/atoms.ts";
import { DashboardBroadcast } from "./dashboard/broadcast.ts";
import { bootstrapSyncPipeline } from "./bootstrap-sync.ts";
import { layerServerProtocolChromePort } from "./rpc-transport.ts";

export const NodeRpcHandlers = NodeRpcs.toLayer(
  Effect.gen(function* () {
    const broadcast = yield* DashboardBroadcast;

    return NodeRpcs.of({
      BroadcastDeltas: () =>
        Stream.concat(
          Stream.sync(() => buildDeltaJson(registry)),
          Stream.fromPubSub(broadcast),
        ),

      StartSync: () =>
        Effect.gen(function* () {
          yield* Effect.log("[rpc] StartSync — forking bootstrap pipeline");
          yield* pushNodeState({ status: "connecting" });
          yield* Effect.forkDetach(
            bootstrapSyncPipeline.pipe(
              Effect.tapError((err) =>
                pushNodeState({ status: "error", lastError: String(err) }),
              ),
            ),
          );
          return { ok: true };
        }),
    });
  }),
);

/**
 * Composes:
 *   - NodeRpcHandlers (BroadcastDeltas, StartSync)
 *   - chrome.runtime.Port server protocol
 *
 * Caller must provide `DashboardBroadcast.Live` so the same PubSub is
 * shared with whatever else publishes to it (currently only the
 * broadcast fiber forked inside `DashboardBroadcast.Live`).
 */
export const RpcServerLive = RpcServer.layer(NodeRpcs, {
  disableFatalDefects: true,
}).pipe(Layer.provide(NodeRpcHandlers), Layer.provide(layerServerProtocolChromePort));
