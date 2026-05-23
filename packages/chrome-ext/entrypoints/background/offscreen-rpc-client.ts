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

declare global {
  // eslint-disable-next-line no-var
  var __GEROLAMINO_OFFSCREEN_RPC_CLIENT__: OffscreenClientType | undefined;
}

export class OffscreenClient extends Context.Service<
  OffscreenClient,
  OffscreenClientType
>()("OffscreenClient") {}

/** One BC listener per SW lifetime. `Layer.launch(RpcServerLive)` and
 *  `Effect.provide(OffscreenClientLive)` on the boot program previously
 *  each constructed a client (both `clientId=0`) → response mis-routing
 *  and popup `Ping` hitting a 90s `TimeoutError` at upload step 2.5. */
const makeSingletonOffscreenClient = Effect.gen(function* () {
  const existing = globalThis.__GEROLAMINO_OFFSCREEN_RPC_CLIENT__;
  if (existing !== undefined) {
    return existing;
  }
  const client = yield* RpcClient.make(OffscreenRpcs);
  globalThis.__GEROLAMINO_OFFSCREEN_RPC_CLIENT__ = client;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      globalThis.__GEROLAMINO_OFFSCREEN_RPC_CLIENT__ = undefined;
    }),
  );
  return client;
});

/** Layer that constructs the shared client. `Layer.effect` (NOT
 *  `Layer.scoped` — removed in Effect 4) accepts a scoped Effect;
 *  the BroadcastChannel + listener live for the layer's lifetime.
 *
 *  NDJSON serialization is provided to match the offscreen-side server's
 *  layer (see `entrypoints/offscreen/main.ts`). Without a serialization
 *  layer the RPC dispatch silently fails — the wire envelope decodes
 *  but the request never reaches the handler. */
export const OffscreenClientLive = Layer.effect(OffscreenClient, makeSingletonOffscreenClient).pipe(
  Layer.provide(layerClientProtocolBroadcastChannel),
  Layer.provide(RpcSerialization.layerNdjson),
);

/** Wrap a SW→offscreen relay RPC with cold-start-tolerant retries.
 *  Per-attempt timeout (3 s) absorbs the offscreen's ~5 s WASM-init
 *  window; 500 ms-spaced retries fire promptly so the second attempt
 *  lands once the offscreen RpcServer is listening. Total budget:
 *  60 attempts × ~3.5 s ≈ 3.5 min before giving up.
 *
 *  Use this for FAST operations where the only legitimate latency is
 *  the offscreen's cold-start (Ping, RequestRestart, InspectOpfsSnapshot).
 *  For slow operations like snapshot upload or lsm-tree session reopen,
 *  use `relayLong` — those can take 10-30 s under load and a 3-second
 *  per-attempt timeout creates RPC retry cascades where the offscreen
 *  dispatches the same request multiple times to the lsm-worker, all
 *  racing for the same exclusive OPFS sync handle and deadlocking the
 *  upload pipeline (the May-2026 release-loop diagnostic surfaced this
 *  via `e2e/upload-synthetic.spec.ts`'s worker-side log relay).
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

/** `Ping` only — short per-attempt budget so popup step 2.5 (90s cap) is not
 *  dominated by one SW `relayRetry` call (~3.5 min). */
export const relayPing = <A, E, R>(
  self: Effect.Effect<A, E | RpcClientError, R>,
): Effect.Effect<A, E | RpcClientError, R> =>
  self.pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () =>
        Effect.fail(
          new RpcClientError({
            reason: new RpcClientDefect({
              message: "relayPing: per-attempt timeout after 2s",
              cause: new Error("relayPing timeout"),
            }),
          }),
        ),
    }),
    Effect.retry({
      schedule: Schedule.spaced("250 millis"),
      times: 20,
    }),
  );

/** Slow relay with bounded retries — use for ops that are idempotent and
 *  do not touch exclusive OPFS sync handles (not snapshot upload). */
export const relayLong = <A, E, R>(
  self: Effect.Effect<A, E | RpcClientError, R>,
): Effect.Effect<A, E | RpcClientError, R> =>
  self.pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(
          new RpcClientError({
            reason: new RpcClientDefect({
              message: "relayLong: per-attempt timeout after 60s",
              cause: new Error("relayLong timeout"),
            }),
          }),
        ),
    }),
    Effect.retry({
      schedule: Schedule.spaced("1 second"),
      times: 4,
    }),
  );

/** Snapshot upload chunks + `ReopenAfterSnapshot` — **no retries**.
 *  `relayLong`'s 60 s × 5 retry budget re-dispatches the same chunk while
 *  the lsm-worker still holds (or is opening) the path's sync handle;
 *  concurrent `createSyncAccessHandle` on one file deadlocks OPFS under
 *  Playwright (see `project_synthetic_spec_worker_logs.md`). One 180 s
 *  attempt matches `upload-synthetic.spec.ts` poll budget. */
export const relayUpload = <A, E, R>(
  self: Effect.Effect<A, E | RpcClientError, R>,
): Effect.Effect<A, E | RpcClientError, R> =>
  self.pipe(
    Effect.timeoutOrElse({
      duration: "180 seconds",
      orElse: () =>
        Effect.fail(
          new RpcClientError({
            reason: new RpcClientDefect({
              message: "relayUpload: timeout after 180s",
              cause: new Error("relayUpload timeout"),
            }),
          }),
        ),
    }),
  );
