#!/usr/bin/env bun
/**
 * Miniprotocol smoke test through the local websockify relay proxy.
 *
 * Prerequisites:
 *   nix run nixpkgs#python3Packages.websockify -- \
 *     --heartbeat=30 127.0.0.1:3040 preprod-node.world.dev.cardano.org:3001
 *
 * Run:
 *   RELAY_WS_URL=ws://87.99.129.190:3040 bun packages/miniprotocols/src/__tests__/preprod-proxy-e2e.ts
 *
 * Uses the same N2N stack as chrome-ext / consensus `connectToRelay`, but
 * over `Socket.makeWebSocket` (binary frames) instead of raw TCP.
 */
import { Duration, Effect, Layer, Schema } from "effect";
import * as Socket from "effect/unstable/socket/Socket";

import { Multiplexer } from "../multiplexer/Multiplexer.ts";
import { MultiplexerBuffer } from "../multiplexer/Buffer.ts";
import { HandshakeClient } from "../protocols/handshake/Client.ts";
import { HandshakeMessage, HandshakeMessageType } from "../protocols/handshake/Schemas.ts";
import { KeepAliveClient } from "../protocols/keep-alive/Client.ts";
import { ChainSyncClient } from "../protocols/chain-sync/Client.ts";
import { ChainPointType } from "../protocols/types/ChainPoint.ts";
import { RelayWsUrl } from "./relay-test-config.ts";

class HandshakeFailed extends Schema.TaggedErrorClass<HandshakeFailed>()("HandshakeFailed", {
  tag: Schema.String,
}) {}

class KeepAliveMismatch extends Schema.TaggedErrorClass<KeepAliveMismatch>()("KeepAliveMismatch", {
  expected: Schema.Number,
  got: Schema.Number,
}) {}

const preprodVersionTable = {
  _tag: "node-to-node" as const,
  data: {
    14: {
      networkMagic: 1,
      initiatorOnlyDiffusionMode: false,
      peerSharing: 0,
      query: false,
    },
  },
} as const;

const program = Effect.gen(function* () {
  const proxyWsUrl = yield* RelayWsUrl;
  yield* Effect.log(`Miniprotocol proxy E2E (${proxyWsUrl} → preprod N2N)`);

  const socket = yield* Socket.makeWebSocket(proxyWsUrl);
  yield* Effect.log(`WebSocket connected to ${proxyWsUrl}`);

  const muxLayers = Multiplexer.layer.pipe(Layer.provide(MultiplexerBuffer.layer));

  const protocols = Layer.mergeAll(
    HandshakeClient.layer,
    KeepAliveClient.layer,
    ChainSyncClient.layer,
  ).pipe(Layer.provide(muxLayers));

  yield* Effect.gen(function* () {
    const hs = yield* HandshakeClient;
    const hsResult = yield* hs.propose(preprodVersionTable);

    if (!HandshakeMessage.guards[HandshakeMessageType.MsgAcceptVersion](hsResult)) {
      return yield* Effect.fail(new HandshakeFailed({ tag: hsResult._tag }));
    }
    yield* Effect.log(
      `Handshake ok: version=${hsResult.version} magic=${hsResult.versionData.networkMagic}`,
    );

    const ka = yield* KeepAliveClient;
    const cookie = 12_345;
    const echoed = yield* ka.keepAlive(cookie);
    if (echoed !== cookie) {
      return yield* Effect.fail(new KeepAliveMismatch({ expected: cookie, got: echoed }));
    }
    yield* Effect.log(`KeepAlive ok: cookie ${cookie} echoed`);

    const cs = yield* ChainSyncClient;
    const intersect = yield* cs.findIntersect([{ _tag: ChainPointType.Origin }]).pipe(
      Effect.timeout(Duration.seconds(20)),
    );
    yield* Effect.log(`ChainSync FindIntersect: ${intersect._tag}`);
    yield* Effect.log("Proxy path OK — upstream preprod relay is reachable");
  }).pipe(Effect.provide(protocols), Effect.provideService(Socket.Socket, socket));
}).pipe(
  Effect.provide(Socket.layerWebSocketConstructorGlobal),
  Effect.timeout(Duration.seconds(45)),
  Effect.catch((cause) =>
    Effect.gen(function* () {
      yield* Effect.logError("Proxy miniprotocol test failed");
      yield* Effect.logError(
        "Is websockify running? e.g. devenv tasks run relay:websockify",
      );
      return yield* Effect.fail(cause);
    }),
  ),
);

Effect.runPromise(program);
