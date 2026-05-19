/**
 * serve.ts — HTTP + WebSocket server hosting the dashboard SPA bundle
 * and broadcasting atom-state deltas.
 *
 * Pure-Effect composition:
 *
 *   ┌─ Layer.launch ─────────────────────────────────────────────────┐
 *   │ HttpRouter.serve                                                │
 *   │   ├── HttpStaticServer.layer  ← serves `dist-spa/*` + index    │
 *   │   └── HttpRouter.use(/ws)                                       │
 *   │         └── HttpServerRequest.upgrade → Socket.Socket           │
 *   │             └── Stream.fromPubSub(broadcast) → socket.writer    │
 *   │                                                                 │
 *   │ + forked broadcast fiber:                                       │
 *   │   buildDeltaJson(registry) → dedup → PubSub.publish             │
 *   │                                                                 │
 *   │ Provided by BunHttpServer.layer({ port, hostname }).            │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * The PubSub fans the single delta producer out to N concurrent
 * WebSocket subscribers; each subscription is scoped to the handler,
 * so disconnects clean up automatically. A short `initial` snapshot
 * preceeds the pubsub stream so a fresh client doesn't see empty
 * defaults until the next dedup-passing publish.
 *
 * Replaces the prior `Bun.WebView`-driven render path. That path
 * pushed deltas via `view.evaluate(window.__APPLY_DELTAS__(...))` into
 * an embedded headless Chrome, which on Linux Bun has no
 * visible-window mode — so the only way to actually *see* the
 * dashboard is from an external browser pointed at this server.
 */
import { Effect, Layer, PubSub, Stream } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpStaticServer from "effect/unstable/http/HttpStaticServer";
import { BunHttpServer } from "@effect/platform-bun";
// Pull the delta + broadcast helpers from the leaf sub-paths rather
// than the `dashboard` barrel. The barrel re-exports the Solid DOM
// primitives (`Tabs.tsx` etc.); Bun's JSX-runtime resolution for
// those `.tsx` files trips on `react/jsx-dev-runtime` at module-init
// time even though the headless TUI never renders them. Sub-path
// imports keep the Bun-side import graph host-agnostic.
import { buildDeltaJson } from "dashboard/delta.ts";
import { makeBroadcastFiber } from "dashboard/broadcast.ts";
import { registry } from "./atoms.ts";
import { DELTA_PUSH_INTERVAL_MS, DASHBOARD_PORT } from "../constants.ts";

// Bun-native path resolution — `import.meta.dir` is the current module's
// directory; `new URL(rel, base).pathname` resolves the relative bit
// without pulling in `node:path`'s `resolve`.
const SPA_DIST_DIR = new URL(
  "../../../../packages/dashboard/dist-spa",
  `file://${import.meta.dir}/`,
).pathname;

/**
 * Per-connection WebSocket handler. Upgrades the request, then runs a
 * stream that emits the current snapshot once and forwards every
 * subsequent broadcast publish to the socket. Returns a 101 once the
 * stream completes (i.e. the client disconnects), satisfying
 * `HttpServerResponse`'s required-return contract — the data flow
 * happened over the upgraded socket while the handler was blocked on
 * the stream.
 */
const wsHandler = (broadcast: PubSub.PubSub<string>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const wsSocket = yield* request.upgrade;
    const write = yield* wsSocket.writer;
    yield* Stream.runForEach(
      Stream.concat(
        Stream.sync(() => buildDeltaJson(registry)),
        Stream.fromPubSub(broadcast),
      ),
      write,
    );
    return HttpServerResponse.empty({ status: 101 });
  });

const wsRouteLayer = (broadcast: PubSub.PubSub<string>) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      yield* router.add("GET", "/ws", wsHandler(broadcast));
    }),
  );

/**
 * Run the dashboard HTTP+WS server forever. Forks the shared broadcast
 * fiber (`dashboard/broadcast.ts:makeBroadcastFiber`), composes static
 * + WS route layers, launches the Bun-backed HTTP server. Blocks the
 * calling fiber until scope close (Ctrl-C, defect, scope error).
 * Callers should `Effect.forkScoped(startDashboardServer)` to run it
 * as a daemon alongside the consensus stack.
 *
 * Listens on `127.0.0.1:DASHBOARD_PORT` — local-only by default. Open
 * to LAN by changing `hostname` to `"0.0.0.0"` once auth lands.
 */
export const startDashboardServer = Effect.gen(function* () {
  const broadcast = yield* PubSub.unbounded<string>();

  yield* Effect.forkScoped(makeBroadcastFiber(registry, broadcast, DELTA_PUSH_INTERVAL_MS));

  const routerLayer = Layer.mergeAll(
    HttpStaticServer.layer({ root: SPA_DIST_DIR, index: "index.html" }),
    wsRouteLayer(broadcast),
  );

  yield* HttpRouter.serve(routerLayer).pipe(
    Layer.provide(BunHttpServer.layer({ port: DASHBOARD_PORT, hostname: "127.0.0.1" })),
    Layer.launch,
  );
});
