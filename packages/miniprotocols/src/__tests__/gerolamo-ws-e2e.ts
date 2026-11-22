#!/usr/bin/env bun
/**
 * Gerolamino's N2N stack against a Gerolamo node's native N2N-over-WebSocket bearer (no websockify).
 *
 *   GEROLAMO_WS_URL=ws://192.168.1.173:3004/n2n NETWORK_MAGIC=2 \
 *     bun packages/miniprotocols/src/__tests__/gerolamo-ws-e2e.ts
 *
 * Steps: handshake (v14–16, duplex flag as the extension sends it), KeepAlive echo, ChainSync
 * FindIntersect at origin, the first RollForward headers, FindIntersect at the server tip, then
 * RequestNext until a new header arrives, and BlockFetch of the tip block.
 */
import { Duration, Effect, Layer, Schema } from "effect";
import * as Socket from "effect/unstable/socket/Socket";

import { Multiplexer } from "../multiplexer/Multiplexer.ts";
import { MultiplexerBuffer } from "../multiplexer/Buffer.ts";
import { HandshakeClient } from "../protocols/handshake/Client.ts";
import { HandshakeMessage, HandshakeMessageType } from "../protocols/handshake/Schemas.ts";
import { KeepAliveClient } from "../protocols/keep-alive/Client.ts";
import { ChainSyncClient } from "../protocols/chain-sync/Client.ts";
import { ChainSyncMessage } from "../protocols/chain-sync/Schemas.ts";
import { BlockFetchClient } from "../protocols/block-fetch/Client.ts";
import { ChainPointType } from "../protocols/types/ChainPoint.ts";

class Failed extends Schema.TaggedErrorClass<Failed>()("Failed", { step: Schema.String, detail: Schema.String }) {}

const url = process.env.GEROLAMO_WS_URL ?? "ws://127.0.0.1:3004/n2n";
const magic = Number(process.env.NETWORK_MAGIC ?? "2");
const params = { networkMagic: magic, initiatorOnlyDiffusionMode: false, peerSharing: 0, query: false };
const versionTable = { _tag: "node-to-node" as const, data: { 14: params, 15: params, 16: params } } as const;

const program = Effect.gen(function* () {
  yield* Effect.log(`Gerolamino → Gerolamo WS e2e: ${url} (magic ${magic})`);
  const socket = yield* Socket.makeWebSocket(url);
  const muxLayers = Multiplexer.layer.pipe(Layer.provide(MultiplexerBuffer.layer));
  const protocols = Layer.mergeAll(HandshakeClient.layer, KeepAliveClient.layer, ChainSyncClient.layer, BlockFetchClient.layer).pipe(
    Layer.provide(muxLayers),
  );

  yield* Effect.gen(function* () {
    const hs = yield* HandshakeClient;
    const accepted = yield* hs.propose(versionTable as any);
    if (!HandshakeMessage.guards[HandshakeMessageType.MsgAcceptVersion](accepted)) {
      return yield* Effect.fail(new Failed({ step: "handshake", detail: JSON.stringify(accepted) }));
    }
    yield* Effect.log(`1 handshake: version ${accepted.version}, server data ${JSON.stringify(accepted.versionData)}`);

    const ka = yield* KeepAliveClient;
    const echoed = yield* ka.keepAlive(4242);
    if (echoed !== 4242) return yield* Effect.fail(new Failed({ step: "keep-alive", detail: String(echoed) }));
    yield* Effect.log("2 keep-alive: cookie echoed");

    const cs = yield* ChainSyncClient;
    const fromOrigin: any = yield* cs.findIntersect([{ _tag: ChainPointType.Origin }]).pipe(Effect.timeout(Duration.seconds(20)));
    yield* Effect.log(`3 find-intersect origin: ${fromOrigin._tag}; server tip ${JSON.stringify(fromOrigin.tip)}`);
    let forwards = 0;
    for (let i = 0; i < 6; i++) {
      const msg: any = yield* cs.requestNext().pipe(Effect.timeout(Duration.seconds(20)));
      if (ChainSyncMessage.guards.RollForward(msg)) forwards++;
      yield* Effect.log(`   request-next ${i}: ${msg._tag}`);
    }
    if (forwards === 0) return yield* Effect.fail(new Failed({ step: "chain-sync from origin", detail: "no RollForward" }));
    yield* Effect.log(`4 chain-sync from origin: ${forwards} RollForward`);

    const tip = fromOrigin.tip?.point;
    if (!tip || tip._tag === ChainPointType.Origin) return yield* Effect.fail(new Failed({ step: "tip", detail: JSON.stringify(fromOrigin.tip) }));
    const atTip: any = yield* cs.findIntersect([tip]).pipe(Effect.timeout(Duration.seconds(20)));
    yield* Effect.log(`5 find-intersect at tip: ${atTip._tag}`);

    const bf = yield* BlockFetchClient;
    const blocks: any = yield* bf.requestRange(tip, tip).pipe(Effect.timeout(Duration.seconds(30)));
    const n = Array.isArray(blocks) ? blocks.length : (blocks?.blocks?.length ?? (blocks ? 1 : 0));
    yield* Effect.log(`6 block-fetch tip: ${n} block(s), ${JSON.stringify(blocks)?.length ?? 0} chars`);

    let next: any = null;
    for (let i = 0; i < 40 && !ChainSyncMessage.guards.RollForward(next ?? {}); i++) {
      next = yield* cs.requestNext().pipe(Effect.timeout(Duration.seconds(120)));
      yield* Effect.log(`   at tip, request-next ${i}: ${next._tag}`);
    }
    yield* Effect.log(`7 followed the tip: ${next?._tag}`);
    yield* Effect.log("PASS");
  }).pipe(Effect.provide(protocols), Effect.provideService(Socket.Socket, socket));
}).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal), Effect.timeout(Duration.minutes(5)));

Effect.runPromise(program).catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
