/**
 * Offscreen ↔ SW RPC transport — Effect RPC over BroadcastChannel.
 *
 * Phase D Step 1 scaffolding. Mirrors the design of
 * `entrypoints/background/rpc-transport.ts` (Port-based popup ↔ SW
 * transport) but uses `BroadcastChannel` because:
 *   - The SW cannot `chrome.runtime.connect` to the offscreen document;
 *     they aren't in each other's `onConnect` namespace.
 *   - `chrome.runtime.sendMessage` is JSON-only (no `bigint` /
 *     `Uint8Array`) — the dashboard delta payloads need structured-clone.
 *   - `BroadcastChannel` is same-origin pub-sub with full structured
 *     clone, supports `bigint` + `Uint8Array` natively, and is
 *     symmetric — neither side has to be "the server" at the transport
 *     layer.
 *
 * Naming convention: a fixed channel name `gerolamino/offscreen-rpc`.
 * Single offscreen-document-per-extension means there's no namespace
 * collision; if Chrome ever lifts the cap, we'd append the offscreen
 * URL hash here.
 *
 * Single-client model: there's one SW per extension, so `clientId = 0`
 * for every message. Reserved for symmetry with the Port transport's
 * multi-client API; if multi-popup multiplexing through the SW lands,
 * the SW's outbound BroadcastChannel calls already carry a clientId
 * placeholder.
 */
import { Effect, FiberSet, Layer, Predicate, Queue, Scope } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientError, RpcClientDefect } from "effect/unstable/rpc/RpcClientError";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";

/** Shared channel name. Keep in lockstep on both sides — a typo
 *  silently splits the topic and every RPC call hangs. */
export const OFFSCREEN_RPC_CHANNEL = "gerolamino/offscreen-rpc";

/** Wire-tag discriminator embedded in every BroadcastChannel message
 *  so the existing decode-protocol channel (`gerolamino/offscreen`)
 *  isn't mis-listened to. The decode-protocol channel uses a separate
 *  channel name today; this tag is belt-and-suspenders for the future
 *  consolidation in Step 6. */
type RpcEnvelope =
  | { readonly _kind: "request"; readonly clientId: number; readonly data: FromClientEncoded }
  | { readonly _kind: "response"; readonly clientId: number; readonly data: FromServerEncoded };

const SINGLE_CLIENT_ID = 0;

/** Structural narrow of an inbound BroadcastChannel message to our
 *  internal `RpcEnvelope` shape. `Predicate.isObject` confirms the
 *  data is a non-null non-array object; the discriminator-tag check
 *  narrows `_kind` to one of our two literals. The `data` payload
 *  retains its declared `From{Client,Server}Encoded` type via the
 *  discriminated union — no `as` cast at the call sites in
 *  `onMessage`. */
const decodeEnvelope = (data: unknown): RpcEnvelope | null => {
  if (!Predicate.isObject(data)) return null;
  const record = data as Record<string, unknown>;
  const kind = record["_kind"];
  const clientId = record["clientId"];
  const payload = record["data"];
  if (!Predicate.isNumber(clientId)) return null;
  if (kind === "request") {
    return { _kind: "request", clientId, data: payload as FromClientEncoded };
  }
  if (kind === "response") {
    return { _kind: "response", clientId, data: payload as FromServerEncoded };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Client protocol — SW side (calls into the offscreen RPC server)
// ---------------------------------------------------------------------------

export const makeClientProtocolBroadcastChannel: Effect.Effect<
  RpcClient.Protocol["Service"],
  never,
  Scope.Scope
> = RpcClient.Protocol.make(
  Effect.fnUntraced(function* (writeResponse, _clientIds) {
    const channel = new BroadcastChannel(OFFSCREEN_RPC_CHANNEL);
    yield* Effect.addFinalizer(() => Effect.sync(() => channel.close()));

    const fiberSet = yield* FiberSet.make<void, never>();
    const run = yield* FiberSet.runtime(fiberSet)<never>();

    // Ignore our own outbound `request` envelopes — BroadcastChannel
    // delivers to every same-origin listener including the same tab in
    // some MV3 corners (offscreen + SW share an origin), so we must
    // filter by `_kind` to avoid the SW reading its own outbound.
    const onMessage = (event: MessageEvent<unknown>) => {
      const env = decodeEnvelope(event.data);
      if (env === null || env._kind !== "response") return;
      run(writeResponse(env.clientId, env.data));
    };
    channel.addEventListener("message", onMessage);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => channel.removeEventListener("message", onMessage)),
    );

    yield* FiberSet.join(fiberSet).pipe(Effect.forkScoped);

    return {
      send(_clientId: number, request: FromClientEncoded) {
        const envelope: RpcEnvelope = {
          _kind: "request",
          clientId: SINGLE_CLIENT_ID,
          data: request,
        };
        return Effect.sync(() => channel.postMessage(envelope));
      },
      supportsAck: false,
      supportsTransferables: false,
    };
  }),
);

export const layerClientProtocolBroadcastChannel: Layer.Layer<RpcClient.Protocol> = Layer.effect(
  RpcClient.Protocol,
  makeClientProtocolBroadcastChannel,
);

// ---------------------------------------------------------------------------
// Server protocol — offscreen side (handles RPC calls from the SW)
// ---------------------------------------------------------------------------

export const makeServerProtocolBroadcastChannel: Effect.Effect<
  RpcServer.Protocol["Service"],
  never,
  Scope.Scope
> = RpcServer.Protocol.make(
  Effect.fnUntraced(function* (writeRequest) {
    const channel = new BroadcastChannel(OFFSCREEN_RPC_CHANNEL);
    yield* Effect.addFinalizer(() => Effect.sync(() => channel.close()));

    // BroadcastChannel has no "disconnect" event — clients vanish
    // silently. The SW's process termination doesn't fire anything on
    // the offscreen side; we keep the queue here for API symmetry with
    // the Port server (which uses it for the FiberSet rebalancing). It
    // sits idle until SW eviction is detected via a heartbeat in a
    // future step.
    const disconnects = yield* Queue.make<number>();
    const fiberSet = yield* FiberSet.make<void, never>();
    const run = yield* FiberSet.runtime(fiberSet)<never>();

    const onMessage = (event: MessageEvent<unknown>) => {
      const env = decodeEnvelope(event.data);
      if (env === null || env._kind !== "request") return;
      run(writeRequest(env.clientId, env.data));
    };
    channel.addEventListener("message", onMessage);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => channel.removeEventListener("message", onMessage)),
    );

    // Single virtual client — the SW. The set is constant so that the
    // RpcServer scheduler doesn't iterate an empty `clientIds` set on
    // every fan-out; that would silently drop responses.
    const clientIdSet = new Set<number>([SINGLE_CLIENT_ID]);

    yield* FiberSet.join(fiberSet).pipe(Effect.forkScoped);

    return {
      disconnects,
      send(clientId: number, response: FromServerEncoded) {
        const envelope: RpcEnvelope = {
          _kind: "response",
          clientId,
          data: response,
        };
        return Effect.sync(() => channel.postMessage(envelope));
      },
      // BroadcastChannel can't selectively close one peer — `end` is a
      // no-op. Future Step 5 may surface a typed `RpcClientError` that
      // the SW client interprets as "offscreen is restarting", which
      // turns the empty `end` into a proper teardown signal.
      end(_clientId: number) {
        return Effect.void;
      },
      clientIds: Effect.succeed(clientIdSet),
      initialMessage: Effect.succeedNone,
      supportsAck: false,
      supportsTransferables: false,
      supportsSpanPropagation: false,
    };
  }),
);

export const layerServerProtocolBroadcastChannel: Layer.Layer<RpcServer.Protocol> = Layer.effect(
  RpcServer.Protocol,
  makeServerProtocolBroadcastChannel,
);

// Helper for misuse-detection in tests / handlers — `RpcClientError`
// + `RpcClientDefect` aren't exported in the same path everywhere; the
// re-export keeps the chrome-ext tree from importing internals.
export { RpcClientError, RpcClientDefect };
