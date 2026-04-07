/**
 * Bootstrap server: streams Mithril snapshot data to browser clients,
 * then proxies miniprotocol traffic to upstream Cardano node.
 */
import { BunHttpServer } from "@effect/platform-bun";
import { Config, Effect, Layer, Schema, Stream } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";
import type { SnapshotMeta } from "./loader.ts";
import { bootstrapStream } from "./loader.ts";
import { bridgeSockets } from "./proxy.ts";

export const ServerConfig = Schema.Struct({
  port: Config.Port,
  upstreamUrl: Schema.instanceOf(URL),
});
export type ServerConfig = typeof ServerConfig.Type;

const handleClient = (meta: SnapshotMeta, config: ServerConfig) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const wsSocket = yield* request.upgrade;
    const write = yield* wsSocket.writer;

    yield* bootstrapStream(meta).pipe(Stream.runForEach((frame) => write(frame)));

    yield* bridgeSockets(wsSocket, config.upstreamUrl);

    return HttpServerResponse.empty({ status: 101 });
  });

export const startServer = (meta: SnapshotMeta, config: ServerConfig) =>
  HttpRouter.addAll([
    HttpRouter.route(
      "GET",
      "/info",
      HttpServerResponse.json({
        protocolMagic: meta.protocolMagic,
        snapshotSlot: meta.snapshotSlot.toString(),
        totalChunks: meta.totalChunks,
        blobPrefixes: meta.blobPrefixes,
      }),
    ),
    HttpRouter.route("GET", "/bootstrap", handleClient(meta, config)),
  ]).pipe(
    (routes) => HttpRouter.serve(routes),
    Layer.provide(BunHttpServer.layer({ port: config.port })),
    Layer.launch,
  );
