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
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { loadSettingsFromChromeStorageWithRetry } from "../shared/bootstrap-settings.ts";
import { NodeRpcs } from "./rpc.ts";
import {
  OffscreenClient,
  relayLong,
  relayPing,
  relayRetry,
  relayUpload,
} from "./offscreen-rpc-client.ts";
import { layerServerProtocolChromePort } from "./rpc-transport.ts";

export const NodeRpcHandlers = NodeRpcs.toLayer(
  Effect.gen(function* () {
    const offscreen = yield* OffscreenClient;
    return NodeRpcs.of({
      BroadcastDeltas: () => offscreen.SubscribeAtomDeltas().pipe(Stream.orDie),

      Ping: () => relayPing(offscreen.Ping()).pipe(Effect.orDie),

      StartSync: () =>
        Effect.gen(function* () {
          const settings = yield* loadSettingsFromChromeStorageWithRetry(10, 100);
          const result = yield* relayRetry(
            offscreen.RequestRestart({ settings }),
          );
          return { ok: !result.alreadyRunning };
        }).pipe(Effect.orDie),

      // Upload + reopen: single long attempt (`relayUpload`) — retries
      // duplicate in-flight OPFS sync-handle opens and deadlock.
      UploadSnapshotChunk: (payload) =>
        Effect.gen(function* () {
          yield* Effect.logInfo(
            `[gerolamino-sw] UploadSnapshotChunk relay path=${payload.path} offset=${payload.offset} bytes=${payload.bytes.length} final=${payload.final}`,
          );
          yield* relayUpload(offscreen.UploadSnapshotChunk(payload));
          yield* Effect.logInfo(`[gerolamino-sw] UploadSnapshotChunk OK path=${payload.path}`);
        }).pipe(Effect.orDie),

      ReopenAfterSnapshot: () =>
        relayUpload(offscreen.ReopenAfterSnapshot()).pipe(Effect.orDie),

      InspectOpfsSnapshot: () =>
        relayLong(offscreen.InspectOpfsSnapshot()).pipe(Effect.orDie),
    });
  }),
);

/** Handlers + their `OffscreenClient` dependency, composed into a single
 *  Layer so the array-form `Layer.provide` below doesn't have to compose
 *  array elements against each other (it doesn't — each entry is
 *  fed to the parent independently). */
/** Requires `OffscreenClient` via `Layer.provideMerge(OffscreenClientLive)`. */
export const RpcServerLive = RpcServer.layer(NodeRpcs, {
  disableFatalDefects: true,
}).pipe(
  Layer.provide([NodeRpcHandlers, layerServerProtocolChromePort]),
  Layer.provide(RpcSerialization.layerNdjson),
);
