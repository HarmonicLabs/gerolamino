/**
 * RPC server — chrome-ext background service worker (popup-facing).
 *
 * The SW is a thin pass-through: every popup-facing `NodeRpcs` method
 * relays to the matching `OffscreenRpcs` handler over a single shared
 * BroadcastChannel-backed `RpcClient` (`OffscreenClient` service). One
 * persistent client = one listener = deterministic response routing.
 *
 * `relayRetry` absorbs the offscreen daemon's ~5 s cold-start.
 */
import { Effect, Layer, Stream } from "effect";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { NodeRpcs } from "./rpc.ts";
import { OffscreenClient, OffscreenClientLive, relayLong, relayRetry } from "./offscreen-rpc-client.ts";
import { layerServerProtocolChromePort } from "./rpc-transport.ts";

export const NodeRpcHandlers = NodeRpcs.toLayer(
  Effect.gen(function* () {
    const offscreen = yield* OffscreenClient;
    return NodeRpcs.of({
      BroadcastDeltas: () => offscreen.SubscribeAtomDeltas().pipe(Stream.orDie),

      StartSync: () =>
        Effect.gen(function* () {
          const result = yield* relayRetry(offscreen.RequestRestart());
          return { ok: !result.alreadyRunning };
        }).pipe(Effect.orDie),

      // Upload chunks + reopen use `relayLong` (60 s per-attempt timeout)
      // because OPFS sync handles can take seconds to create under load;
      // the older 3 s `relayRetry` caused RPC retry cascades that race
      // for the same exclusive handle and deadlock the pipeline.
      UploadSnapshotChunk: (payload) =>
        relayLong(offscreen.UploadSnapshotChunk(payload)).pipe(Effect.orDie),

      ReopenAfterSnapshot: () =>
        relayLong(offscreen.ReopenAfterSnapshot()).pipe(Effect.orDie),

      InspectOpfsSnapshot: () =>
        relayRetry(offscreen.InspectOpfsSnapshot()).pipe(Effect.orDie),
    });
  }),
);

/** Handlers + their `OffscreenClient` dependency, composed into a single
 *  Layer so the array-form `Layer.provide` below doesn't have to compose
 *  array elements against each other (it doesn't — each entry is
 *  fed to the parent independently). */
const NodeRpcHandlersWithDeps = NodeRpcHandlers.pipe(Layer.provide(OffscreenClientLive));

export const RpcServerLive = RpcServer.layer(NodeRpcs, {
  disableFatalDefects: true,
}).pipe(Layer.provide([NodeRpcHandlersWithDeps, layerServerProtocolChromePort]));
