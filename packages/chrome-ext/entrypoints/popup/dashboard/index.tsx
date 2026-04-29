/**
 * Browser Dashboard — renders the shared dashboard in the Chrome extension popup.
 *
 * Provides:
 *   1. AtomRegistry (mirror of the SW's authoritative registry).
 *   2. DOM-host primitives via `createDomPrimitives()` — same factory the
 *      apps/tui SPA consumes, so visuals + a11y stay consistent.
 *   3. The Dashboard component from `packages/dashboard`.
 *
 * Transport is the same JSON-delta envelope `apps/tui` ships, but routed
 * over Effect RPC's streaming `BroadcastDeltas` endpoint instead of a
 * WebSocket. The SW's broadcast fiber polls its atom registry every
 * 100 ms, dedups, and publishes; this popup subscribes to the stream
 * and runs `applyDelta` on every frame.
 *
 * Reconnect: `Effect.forever` re-enters the Effect.scoped block on any
 * disconnect (clean or error). Brief blank panels appear when the SW
 * evicts and respawns; the chrome.alarms keepalive in the background
 * keeps that window short.
 */
import { Effect, Stream } from "effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RegistryContext } from "@effect/atom-solid";
import { PrimitivesProvider, Dashboard, createDomPrimitives, applyDelta } from "dashboard";
import { NodeRpcs } from "../../background/rpc.ts";
import { layerClientProtocolChromePort } from "../../background/rpc-transport.ts";

const domPrimitives = createDomPrimitives();
const registry = AtomRegistry.make();

// One connection lifecycle: build the RPC client, subscribe to the
// streaming `BroadcastDeltas` endpoint, hand each JSON frame to
// `applyDelta`. The Scope wrapping `RpcClient.make` is what binds the
// chrome.runtime.Port lifetime to this fiber — `Effect.scoped` releases
// it on stream end, which `Effect.forever` then re-enters with a fresh
// Port.
const oneConnection = Effect.gen(function* () {
  const client = yield* RpcClient.make(NodeRpcs);
  yield* Stream.runForEach(client.BroadcastDeltas(), (json) =>
    Effect.sync(() => applyDelta(registry, json)),
  );
}).pipe(
  Effect.scoped,
  Effect.catch((err) =>
    Effect.logWarning(`[popup] dashboard RPC: ${String(err)}`).pipe(
      Effect.andThen(Effect.sleep("1 second")),
    ),
  ),
);

Effect.runFork(oneConnection.pipe(Effect.forever, Effect.provide(layerClientProtocolChromePort)));

/** Top-level browser dashboard for the popup. */
export const BrowserDashboard = () => (
  <RegistryContext.Provider value={registry}>
    <PrimitivesProvider value={domPrimitives}>
      {/* 380 px popup viewport; `dark` forces the dark token palette
          regardless of OS theme until light-theme support lands. */}
      <div class="dark w-[380px] min-h-[480px] p-4 bg-background text-foreground font-sans">
        <Dashboard />
      </div>
    </PrimitivesProvider>
  </RegistryContext.Provider>
);
