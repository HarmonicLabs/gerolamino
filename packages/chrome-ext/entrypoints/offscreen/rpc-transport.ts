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

/** Playwright E2E popup → offscreen upload path. Isolated from the SW's
 *  `clientId=0` listener on `OFFSCREEN_RPC_CHANNEL` so NDJSON responses
 *  are not mis-delivered (symptom: `BlobStoreError` at Rpc decode on
 *  `ReopenAfterSnapshot`). */
export const OFFSCREEN_RPC_E2E_CHANNEL = OFFSCREEN_RPC_CHANNEL;

/** Reserved for the SW relay on `OFFSCREEN_RPC_CHANNEL`. */
export const OFFSCREEN_RPC_SW_CLIENT_ID = 0;

/** Playwright direct-offscreen clients on `OFFSCREEN_RPC_E2E_CHANNEL`. */
export const OFFSCREEN_RPC_E2E_CLIENT_ID = 1;

/** Production popup snapshot upload — bypasses `chrome.runtime.Port` so MV3
 *  SW sleep/restart does not disconnect a multi-hour upload mid-stream. */
export const OFFSCREEN_RPC_POPUP_CLIENT_ID = 2;

/** Wire-tag discriminator embedded in every BroadcastChannel message
 *  so the existing decode-protocol channel (`gerolamino/offscreen`)
 *  isn't mis-listened to. The decode-protocol channel uses a separate
 *  channel name today; this tag is belt-and-suspenders for the future
 *  consolidation in Step 6. */
type RpcEnvelope =
  | { readonly _kind: "request"; readonly clientId: number; readonly data: FromClientEncoded }
  | { readonly _kind: "response"; readonly clientId: number; readonly data: FromServerEncoded };

const objectField = (obj: object, key: string): unknown => Reflect.get(obj, key);

/** Wire-boundary decode for BroadcastChannel envelopes. Rpc codecs validate
 *  `data` once it reaches the RpcServer; here we only check envelope shape. */
export const decodeRpcEnvelope = (data: unknown): RpcEnvelope | null => {
  if (!Predicate.isObject(data)) return null;
  const kind = objectField(data, "_kind");
  const clientId = objectField(data, "clientId");
  const payload = objectField(data, "data");
  if (!Predicate.isNumber(clientId)) return null;
  if (kind === "request") {
    const data = isFromClientEncoded(payload) ? payload : null;
    if (data === null) return null;
    return { _kind: "request", clientId, data };
  }
  if (kind === "response") {
    const data = isFromServerEncoded(payload) ? payload : null;
    if (data === null) return null;
    return { _kind: "response", clientId, data };
  }
  return null;
};

const isFromClientEncoded = (payload: unknown): payload is FromClientEncoded =>
  Predicate.isObject(payload) && "_tag" in payload;

const isFromServerEncoded = (payload: unknown): payload is FromServerEncoded =>
  Predicate.isObject(payload) && "_tag" in payload;

// ---------------------------------------------------------------------------
// Client protocol — SW side (calls into the offscreen RPC server)
// ---------------------------------------------------------------------------

/** Map a wire `clientId` (BC envelope) to the id `RpcClient.make` registered via
 *  `Protocol.run`. They differ when popup uses wire id 2 while Effect assigns 0. */
export const rpcClientIdsForWireResponse = (
  wireClientId: number,
  registeredClientIds: ReadonlySet<number>,
): ReadonlyArray<number> => {
  if (registeredClientIds.size > 0) {
    return [...registeredClientIds];
  }
  // `RpcClient.make` assigns 0 to the first client; buffer until `run(0, …)` installs.
  return [0];
};

const makeClientProtocolBroadcastChannelOn = (
  channelName: string,
  wireClientId: number,
): Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope> =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, registeredClientIds) {
      const channel = new BroadcastChannel(channelName);
      yield* Effect.addFinalizer(() => Effect.sync(() => channel.close()));

      const fiberSet = yield* FiberSet.make<void, never>();
      const run = yield* FiberSet.runtime(fiberSet)<never>();

      // Ignore our own outbound `request` envelopes — BroadcastChannel
      // delivers to every same-origin listener including the same tab in
      // some MV3 corners (offscreen + SW share an origin), so we must
      // filter by `_kind` to avoid the SW reading its own outbound.
      const onMessage = (event: MessageEvent<unknown>) => {
        const env = decodeRpcEnvelope(event.data);
        if (env === null || env._kind !== "response" || env.clientId !== wireClientId) {
          return;
        }
        const [registeredClientId] = rpcClientIdsForWireResponse(
          wireClientId,
          registeredClientIds,
        );
        if (registeredClientId !== undefined) {
          run(writeResponse(registeredClientId, env.data));
        }
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
            clientId: wireClientId,
            data: request,
          };
          return Effect.sync(() => channel.postMessage(envelope));
        },
        supportsAck: false,
        supportsTransferables: false,
      };
    }),
  );

/** SW → offscreen relay (production). */
export const makeClientProtocolBroadcastChannel = makeClientProtocolBroadcastChannelOn(
  OFFSCREEN_RPC_CHANNEL,
  OFFSCREEN_RPC_SW_CLIENT_ID,
);

/** Playwright popup → offscreen upload/reopen (E2E only). Same channel as SW;
 *  `clientId=1` keeps responses off the SW's `clientId=0` slot. */
export const makeClientProtocolBroadcastChannelE2e = makeClientProtocolBroadcastChannelOn(
  OFFSCREEN_RPC_CHANNEL,
  OFFSCREEN_RPC_E2E_CLIENT_ID,
);

/** Production popup → offscreen snapshot upload (`clientId=2`). */
export const makeClientProtocolBroadcastChannelPopup = makeClientProtocolBroadcastChannelOn(
  OFFSCREEN_RPC_CHANNEL,
  OFFSCREEN_RPC_POPUP_CLIENT_ID,
);

export const layerClientProtocolBroadcastChannel: Layer.Layer<RpcClient.Protocol> = Layer.effect(
  RpcClient.Protocol,
  makeClientProtocolBroadcastChannel,
);

export const layerClientProtocolBroadcastChannelE2e: Layer.Layer<RpcClient.Protocol> =
  Layer.effect(RpcClient.Protocol, makeClientProtocolBroadcastChannelE2e);

export const layerClientProtocolBroadcastChannelPopup: Layer.Layer<RpcClient.Protocol> =
  Layer.effect(RpcClient.Protocol, makeClientProtocolBroadcastChannelPopup);

// ---------------------------------------------------------------------------
// Server protocol — offscreen side (handles RPC calls from the SW)
// ---------------------------------------------------------------------------

const OFFSCREEN_SERVER_CHANNELS = [OFFSCREEN_RPC_CHANNEL] as const;

export const makeServerProtocolBroadcastChannel: Effect.Effect<
  RpcServer.Protocol["Service"],
  never,
  Scope.Scope
> = RpcServer.Protocol.make(
  Effect.fnUntraced(function* (writeRequest) {
    const channels = OFFSCREEN_SERVER_CHANNELS.map((name) => new BroadcastChannel(name));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const ch of channels) ch.close();
      }),
    );

    // BroadcastChannel has no "disconnect" event — clients vanish
    // silently. The SW's process termination doesn't fire anything on
    // the offscreen side; we keep the queue here for API symmetry with
    // the Port server (which uses it for the FiberSet rebalancing). It
    // sits idle until SW eviction is detected via a heartbeat in a
    // future step.
    const disconnects = yield* Queue.make<number>();
    const fiberSet = yield* FiberSet.make<void, never>();
    const run = yield* FiberSet.runtime(fiberSet)<never>();

    const clientIdSet = new Set<number>([OFFSCREEN_RPC_SW_CLIENT_ID]);
    const responseChannelByClientId = new Map<number, BroadcastChannel>();

    const onMessage = (event: MessageEvent<unknown>, channel: BroadcastChannel) => {
      const env = decodeRpcEnvelope(event.data);
      if (env === null || env._kind !== "request") return;
      clientIdSet.add(env.clientId);
      responseChannelByClientId.set(env.clientId, channel);
      run(writeRequest(env.clientId, env.data));
    };

    for (const channel of channels) {
      const handler = (event: MessageEvent<unknown>) => onMessage(event, channel);
      channel.addEventListener("message", handler);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => channel.removeEventListener("message", handler)),
      );
    }

    yield* FiberSet.join(fiberSet).pipe(Effect.forkScoped);

    return {
      disconnects,
      send(clientId: number, response: FromServerEncoded) {
        const envelope: RpcEnvelope = {
          _kind: "response",
          clientId,
          data: response,
        };
        const channel =
          responseChannelByClientId.get(clientId) ?? channels[0]!;
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
