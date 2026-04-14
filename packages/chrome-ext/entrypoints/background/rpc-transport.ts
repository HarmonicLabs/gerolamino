/**
 * Chrome extension RPC transport — Effect RPC Protocol implementations
 * for globalThis.chrome.runtime.Port messaging (popup ↔ background).
 *
 * globalThis.chrome.runtime.Port uses structured clone for message passing, so no
 * separate serialization layer is needed — RPC messages pass directly.
 *
 * Client protocol: popup connects to background via globalThis.chrome.runtime.connect.
 * Server protocol: background accepts connections via globalThis.chrome.runtime.onConnect.
 */
import { Effect, FiberSet, Layer, Queue, Scope } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientError, RpcClientDefect } from "effect/unstable/rpc/RpcClientError";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";

// ---------------------------------------------------------------------------
// Client Protocol — popup side (connects to background service worker)
// ---------------------------------------------------------------------------

/**
 * Create an RPC client protocol over globalThis.chrome.runtime.Port.
 *
 * Opens a long-lived port to the background service worker. Messages are
 * sent/received via port.postMessage with structured clone — no serialization
 * layer needed. FiberSet.runtime bridges the event-based Port API into
 * the Effect fiber scheduler.
 */
export const makeClientProtocolChromePort: Effect.Effect<
  RpcClient.Protocol["Service"],
  never,
  Scope.Scope
> = RpcClient.Protocol.make(
  Effect.fnUntraced(function* (writeResponse, _clientIds) {
    const port = globalThis.chrome.runtime.connect({ name: "rpc" });
    const CLIENT_ID = 0; // Single-client protocol (one popup → one background)

    yield* Effect.addFinalizer(() => Effect.sync(() => port.disconnect()));

    // FiberSet bridges event callbacks → Effect fibers with proper context
    const fiberSet = yield* FiberSet.make<void, never>();
    const run = yield* FiberSet.runtime(fiberSet)<never>();

    // Forward port messages to RPC client internals
    port.onMessage.addListener((data: FromServerEncoded) => {
      run(writeResponse(CLIENT_ID, data));
    });

    // Signal protocol error on disconnect
    port.onDisconnect.addListener(() => {
      run(
        writeResponse(CLIENT_ID, {
          _tag: "ClientProtocolError",
          error: new RpcClientError({
            reason: new RpcClientDefect({
              message: "Chrome runtime port disconnected",
              cause: globalThis.chrome.runtime.lastError ?? new Error("Port disconnected"),
            }),
          }),
        }),
      );
    });

    // Keep FiberSet alive in background scope
    yield* FiberSet.join(fiberSet).pipe(Effect.forkScoped);

    return {
      send(_clientId: number, request: FromClientEncoded) {
        return Effect.sync(() => port.postMessage(request));
      },
      supportsAck: false,
      supportsTransferables: false,
    };
  }),
);

/**
 * Layer providing RPC client protocol via globalThis.chrome.runtime.Port.
 */
export const layerClientProtocolChromePort: Layer.Layer<RpcClient.Protocol> = Layer.effect(
  RpcClient.Protocol,
  makeClientProtocolChromePort,
);

// ---------------------------------------------------------------------------
// Server Protocol — background service worker side (accepts popup connections)
// ---------------------------------------------------------------------------

/**
 * Create an RPC server protocol over globalThis.chrome.runtime.Port.
 *
 * Listens for globalThis.chrome.runtime.onConnect and assigns each port a unique
 * clientId. Per-port messages are decoded and forwarded to the RPC server
 * via writeRequest. Disconnects are tracked via a Queue.
 */
export const makeServerProtocolChromePort: Effect.Effect<
  RpcServer.Protocol["Service"],
  never,
  Scope.Scope
> = RpcServer.Protocol.make(
  Effect.fnUntraced(function* (writeRequest) {
    const disconnects = yield* Queue.make<number>();
    const fiberSet = yield* FiberSet.make<void, never>();
    const run = yield* FiberSet.runtime(fiberSet)<never>();

    let nextClientId = 0;
    const clients = new Map<number, globalThis.chrome.runtime.Port>();
    const clientIdSet = new Set<number>();

    // Accept incoming port connections from popup/content scripts
    const onConnect = (port: globalThis.chrome.runtime.Port) => {
      if (port.name !== "rpc") return;

      const clientId = nextClientId++;
      clients.set(clientId, port);
      clientIdSet.add(clientId);
      run(Effect.log(`[rpc-transport] Client ${clientId} connected (active=${clientIdSet.size})`));

      // Forward port messages → RPC server
      port.onMessage.addListener((data: FromClientEncoded) => {
        run(writeRequest(clientId, data));
      });

      // Track disconnects
      port.onDisconnect.addListener(() => {
        clients.delete(clientId);
        clientIdSet.delete(clientId);
        run(
          Effect.log(
            `[rpc-transport] Client ${clientId} disconnected (active=${clientIdSet.size})`,
          ),
        );
        run(Queue.offer(disconnects, clientId));
      });
    };

    globalThis.chrome.runtime.onConnect.addListener(onConnect);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        globalThis.chrome.runtime.onConnect.removeListener(onConnect);
        for (const port of clients.values()) {
          port.disconnect();
        }
        clients.clear();
        clientIdSet.clear();
      }),
    );

    // Keep FiberSet alive
    yield* FiberSet.join(fiberSet).pipe(Effect.forkScoped);

    return {
      disconnects,
      send(clientId: number, response: FromServerEncoded) {
        const port = clients.get(clientId);
        if (!port) return Effect.void;
        return Effect.sync(() => port.postMessage(response));
      },
      end(clientId: number) {
        const port = clients.get(clientId);
        if (port) {
          port.disconnect();
          clients.delete(clientId);
          clientIdSet.delete(clientId);
        }
        return Effect.void;
      },
      clientIds: Effect.sync(() => clientIdSet),
      initialMessage: Effect.succeedNone,
      supportsAck: false,
      supportsTransferables: false,
      supportsSpanPropagation: false,
    };
  }),
);

/**
 * Layer providing RPC server protocol via globalThis.chrome.runtime.Port.
 */
export const layerServerProtocolChromePort: Layer.Layer<RpcServer.Protocol> = Layer.effect(
  RpcServer.Protocol,
  makeServerProtocolChromePort,
);
