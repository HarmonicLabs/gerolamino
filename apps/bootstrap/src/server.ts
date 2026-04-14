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
import type { SnapshotMeta, PreloadedLedger } from "./loader.ts";
import { bootstrapStream } from "./loader.ts";
import { bridgeSockets } from "./proxy.ts";

export const ServerConfig = Schema.Struct({
  port: Config.Port,
  upstreamUrl: Schema.instanceOf(URL),
});
export type ServerConfig = typeof ServerConfig.Type;

const handleClient = (meta: SnapshotMeta, config: ServerConfig, preloaded: PreloadedLedger) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const wsSocket = yield* request.upgrade;
    const write = yield* wsSocket.writer;

    yield* bootstrapStream(meta, preloaded).pipe(Stream.runForEach((frame) => write(frame)));

    yield* bridgeSockets(wsSocket, config.upstreamUrl);

    return HttpServerResponse.empty({ status: 101 });
  });

/** Relay-only: skip bootstrap, proxy to upstream Cardano node immediately. */
const handleRelay = (config: ServerConfig) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const wsSocket = yield* request.upgrade;

    yield* Effect.log("[relay] Client connected — proxying to upstream");
    yield* bridgeSockets(wsSocket, config.upstreamUrl);

    return HttpServerResponse.empty({ status: 101 });
  });

export const startServer = (meta: SnapshotMeta, config: ServerConfig, preloaded: PreloadedLedger) =>
  HttpRouter.addAll([
    HttpRouter.route(
      "GET",
      "/info",
      HttpServerResponse.json({
        protocolMagic: meta.protocolMagic,
        snapshotSlot: meta.snapshotSlot.toString(),
        totalChunks: meta.totalChunks,
      }),
    ),
    HttpRouter.route("GET", "/bootstrap", handleClient(meta, config, preloaded)),
    HttpRouter.route("GET", "/relay", handleRelay(config)),
  ]).pipe(
    (routes) => HttpRouter.serve(routes),
    Layer.provide(BunHttpServer.layer({ port: config.port, hostname: "0.0.0.0" })),
    Layer.launch,
  );
