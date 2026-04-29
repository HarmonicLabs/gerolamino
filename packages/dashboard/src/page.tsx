/**
 * page.tsx — SPA entry consumed by the apps/tui HTTP server.
 *
 * Mounts the dashboard inside a normal browser tab (or Bun.WebView) and
 * connects to the host over a WebSocket whose origin matches the page.
 * Each frame is a JSON delta produced by the host's `buildDeltaJson` —
 * we hand it to the shared `applyDelta` to update this page's mirror
 * registry.
 *
 * Build: `bun packages/dashboard/build.ts` produces `dist-spa/index.html`,
 * served by `apps/tui/src/dashboard/serve.ts`.
 */
import { render } from "solid-js/web";
import { Effect } from "effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import * as Socket from "effect/unstable/socket/Socket";
import { RegistryContext } from "@effect/atom-solid";
import {
  Dashboard,
  PrimitivesProvider,
  createDomPrimitives,
  applyDelta,
} from "./index";

const registry = AtomRegistry.make();
const domPrimitives = createDomPrimitives();

// Legacy hook for the (currently unused) Bun.WebView `view.evaluate`
// push path; the live transport is the WebSocket below.
declare global {
  interface Window {
    __APPLY_DELTAS__?: (raw: string) => void;
  }
}
window.__APPLY_DELTAS__ = (raw) => applyDelta(registry, raw);

const root = document.getElementById("root");
if (!root) throw new Error("page.tsx: #root not found in DOM");

render(
  () => (
    <RegistryContext.Provider value={registry}>
      <PrimitivesProvider value={domPrimitives}>
        <div class="dark size-full bg-background text-foreground font-sans">
          <Dashboard />
        </div>
      </PrimitivesProvider>
    </RegistryContext.Provider>
  ),
  root,
);

// WebSocket transport via Effect. When loaded over `http(s)://`, open a
// `Socket.makeWebSocket` to the same origin's `/ws` endpoint — the host's
// broadcast fiber publishes atom deltas there. The `file://` path (page
// opened directly from disk) is skipped: there's no host to talk to, so
// the page renders initial atom defaults and stays static.
//
// Lifecycle: `socket.runRaw` blocks the fiber for the lifetime of the
// WS, dispatching each frame through `applyDelta`. The dashboard
// protocol is text-only, but `runRaw` may surface either `string` (text
// frames) or `Uint8Array` (binary), so the handler ignores the latter
// defensively. On any close (clean or socket error), `Effect.forever`
// restarts the cycle after the 1s sleep below — covers TUI restart,
// transient network, page-side reload-survival.
if (location.protocol === "http:" || location.protocol === "https:") {
  const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  const oneConnection = Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(wsUrl);
    yield* socket.runRaw((message) =>
      Effect.sync(() => {
        if (typeof message === "string") applyDelta(registry, message);
      }),
    );
  }).pipe(
    Effect.catch((err) =>
      Effect.logWarning(`dashboard WS: ${String(err)}`).pipe(
        Effect.andThen(Effect.sleep("1 second")),
      ),
    ),
  );
  Effect.runFork(
    oneConnection.pipe(
      Effect.forever,
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
    ),
  );
}
