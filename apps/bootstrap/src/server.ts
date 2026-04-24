/**
 * Bootstrap server entrypoint.
 *
 * Composes two route sources into a single `HttpRouter`:
 *   - `HttpApiBuilder.layer(BootstrapApi, { openapiPath: "/openapi.json" })`
 *     — schema-first REST endpoints (`/info`, `/snapshots`, `/sync-status`,
 *     `/peers`, `/mempool`) + auto OpenAPI spec.
 *   - `HttpApiSwagger.layer(BootstrapApi, { path: "/docs" })` — interactive
 *     Swagger UI over the auto-generated spec.
 *   - `wsRoutesLayer` — raw WebSocket upgrades for `/bootstrap` + `/relay`.
 *     WS upgrades can't sit behind HttpApi (schema-first request/response
 *     doesn't cover socket upgrade semantics); they're added directly to
 *     the same `HttpRouter` via `HttpRouter.use`.
 */
import { BunHttpServer } from "@effect/platform-bun";
import { Config, Effect, Layer, Schema, Stream } from "effect";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiSwagger from "effect/unstable/httpapi/HttpApiSwagger";
import { BootstrapApi, infoGroupLayer } from "./http-api.ts";
import type { SnapshotMeta, PreloadedLedger } from "./loader.ts";
import { bootstrapStream } from "./loader.ts";
import { bridgeSockets } from "./proxy.ts";

export const ServerConfig = Schema.Struct({
  port: Config.Port,
  upstreamUrl: Schema.instanceOf(URL),
});
export type ServerConfig = typeof ServerConfig.Type;

/** `GET /bootstrap` — replays snapshot data then bridges to upstream relay. */
const handleClient = (meta: SnapshotMeta, config: ServerConfig, preloaded: PreloadedLedger) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const wsSocket = yield* request.upgrade;
    const write = yield* wsSocket.writer;
    yield* bootstrapStream(meta, preloaded).pipe(Stream.runForEach((frame) => write(frame)));
    yield* bridgeSockets(wsSocket, config.upstreamUrl);
    return HttpServerResponse.empty({ status: 101 });
  });

/** `GET /relay` — skip bootstrap, proxy directly to upstream Cardano node. */
const handleRelay = (config: ServerConfig) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const wsSocket = yield* request.upgrade;
    yield* Effect.log("[relay] Client connected — proxying to upstream");
    yield* bridgeSockets(wsSocket, config.upstreamUrl);
    return HttpServerResponse.empty({ status: 101 });
  });

/** Raw WS routes added via `HttpRouter.use` — sibling of HttpApiBuilder.layer. */
const wsRoutesLayer = (meta: SnapshotMeta, config: ServerConfig, preloaded: PreloadedLedger) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      yield* router.add("GET", "/bootstrap", handleClient(meta, config, preloaded));
      yield* router.add("GET", "/relay", handleRelay(config));
    }),
  );

/**
 * CORS allow-list. `CORS_ORIGINS` is a comma-separated list; `*` keeps the
 * dashboard / chrome-ext / curl all happy during development. Production
 * deploys narrow via the env var.
 */
const CorsOriginsConfig = Config.string("CORS_ORIGINS").pipe(Config.withDefault("*"));

const parseOrigins = (raw: string): ReadonlyArray<string> =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export const startServer = (
  meta: SnapshotMeta,
  config: ServerConfig,
  preloaded: PreloadedLedger,
) => {
  const apiLive = HttpApiBuilder.layer(BootstrapApi, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(infoGroupLayer(meta)),
  );
  const corsLayer = Layer.unwrap(
    Effect.gen(function* () {
      const raw = yield* CorsOriginsConfig;
      return HttpRouter.middleware(
        HttpMiddleware.cors({
          allowedOrigins: parseOrigins(raw),
          allowedMethods: ["GET", "POST", "OPTIONS"],
          allowedHeaders: ["Content-Type", "Authorization"],
          credentials: false,
          maxAge: 600,
        }),
        { global: true },
      );
    }),
  );
  const routerLayer = Layer.mergeAll(
    apiLive,
    HttpApiSwagger.layer(BootstrapApi, { path: "/docs" }),
    wsRoutesLayer(meta, config, preloaded),
    corsLayer,
  );
  return HttpRouter.serve(routerLayer).pipe(
    Layer.provide(BunHttpServer.layer({ port: config.port, hostname: "0.0.0.0" })),
    Layer.launch,
  );
};
