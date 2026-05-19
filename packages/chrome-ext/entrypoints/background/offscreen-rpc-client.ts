/**
 * SW-side helpers around the offscreen RpcServer.
 *
 * Exposes a single shared `OffscreenClient` (BroadcastChannel-backed
 * RpcClient) that lives as long as the SW process does. Each relay
 * handler in `./rpc-server.ts` reads this service from context
 * instead of constructing its own per-call client. Rationale:
 *
 *   - Per-call clients construct N BroadcastChannels sharing one
 *     channel name. Each scope's request-ID counter starts at 0;
 *     responses with id=0 broadcast back to ALL listeners → every
 *     scope tries to match → routing is non-deterministic when
 *     pending requests overlap. This was the original "upload stalls
 *     at 0 MiB" symptom.
 *   - For a 17000-chunk Mithril snapshot, per-call clients also
 *     create 17000 BroadcastChannels — non-trivial allocation +
 *     listener-registration overhead.
 *   - One persistent client = one listener = one ID counter = one
 *     pending map. Deterministic routing + zero per-call setup cost.
 *
 * `relayRetry` covers the offscreen daemon's ~5 s cold-start
 * (WASM compile + worker spawn). The shared client tolerates this
 * because BroadcastChannel doesn't fail loudly when no listener is
 * subscribed — the request is broadcast and forgotten. retries
 * re-send until the offscreen's server-side listener registers.
 */
import { Context, Effect, Layer, Schedule } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { OffscreenRpcs } from "../offscreen/rpc.ts";
import { layerClientProtocolBroadcastChannel } from "../offscreen/rpc-transport.ts";

type OffscreenClientType = RpcClient.FromGroup<typeof OffscreenRpcs, RpcClientError>;

export class OffscreenClient extends Context.Service<
  OffscreenClient,
  OffscreenClientType
>()("OffscreenClient") {}

/** Layer that constructs the shared client. `Layer.effect` (NOT
 *  `Layer.scoped` — removed in Effect 4) accepts a scoped Effect;
 *  the BroadcastChannel + listener live for the layer's lifetime.
 *
 *  NDJSON serialization is provided to match the offscreen-side server's
 *  layer (see `entrypoints/offscreen/main.ts`). Without a serialization
 *  layer the RPC dispatch silently fails — the wire envelope decodes
 *  but the request never reaches the handler. */
export const OffscreenClientLive = Layer.effect(
  OffscreenClient,
  RpcClient.make(OffscreenRpcs),
).pipe(
  Layer.provide(layerClientProtocolBroadcastChannel),
  Layer.provide(RpcSerialization.layerNdjson),
);

/** Wrap a SW→offscreen relay RPC with cold-start-tolerant retries.
 *  Per-attempt timeout (3 s) absorbs the offscreen's ~5 s WASM-init
 *  window; 500 ms-spaced retries fire promptly so the second attempt
 *  lands once the offscreen RpcServer is listening. Total budget:
 *  60 attempts × ~3.5 s ≈ 3.5 min before giving up.
 *
 *  `Effect.timeoutOrElse` substitutes a typed `RpcClientError` rather
 *  than widening the error channel with `TimeoutException` — keeps
 *  the caller's `E` channel stable so handlers downstream don't have
 *  to match an extra failure shape. */
export const relayRetry = <A, E, R>(
  self: Effect.Effect<A, E | RpcClientError, R>,
): Effect.Effect<A, E | RpcClientError, R> =>
  self.pipe(
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () =>
        Effect.fail(
          new RpcClientError({
            reason: new RpcClientDefect({
              message: "relayRetry: per-attempt timeout after 3s",
              cause: new Error("relayRetry timeout"),
            }),
          }),
        ),
    }),
    Effect.retry({
      schedule: Schedule.spaced("500 millis"),
      times: 60,
    }),
  );
