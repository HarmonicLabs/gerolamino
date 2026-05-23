/**
 * Background service worker — Gerolamino in-browser Cardano node.
 *
 * Phase D Step 3 stage 3b2: the SW is now a thin RPC gateway. The
 * Effect runtime + atom registry + bootstrap-sync + consensus driver
 * + WS connection all live in the offscreen document under the
 * `WORKERS` reason (Chrome 124+, indefinite lifetime). The SW's only
 * jobs are:
 *   1. Set up the watchdog alarm (re-create offscreen on
 *      renderer-OOM / extension-update / browser-restart).
 *   2. Launch the popup-facing `RpcServerLive` over
 *      `chrome.runtime.Port`. Its `BroadcastDeltas` handler is now a
 *      relay over the offscreen's `SubscribeAtomDeltas` stream.
 *
 * The SW can sleep — chrome.runtime events wake it on demand (popup
 * connect, alarms tick, onStartup, onInstalled). The offscreen is the
 * persistent compute daemon.
 */
import "./ensure-offscreen-handler.ts";
import { Effect, Layer } from "effect";
import { RpcServerLive } from "./rpc-server.ts";
import { ensureOffscreen } from "./offscreen-client.ts";
import { awaitChromePortServerListening } from "./rpc-transport.ts";
import { OffscreenClientLive } from "./offscreen-rpc-client.ts";
import { TestLogBufferLayer } from "../shared/test-log-buffer.ts";

// ---------------------------------------------------------------------------
// Offscreen daemon watchdog (5-minute sentinel, not a keepalive)
// ---------------------------------------------------------------------------

const OFFSCREEN_WATCHDOG_ALARM = "gerolamino-offscreen-watchdog";

function setupOffscreenWatchdog() {
  // 5-minute period — the daemon's natural lifetime is indefinite (WORKERS
  // Reason). The watchdog fires only to re-create after a kill (renderer
  // OOM, extension auto-update, profile reload) — not for keepalive.
  globalThis.chrome.alarms.create(OFFSCREEN_WATCHDOG_ALARM, { periodInMinutes: 5 });
  globalThis.chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== OFFSCREEN_WATCHDOG_ALARM) return;
    // Recreate-if-missing on every alarm tick. `ensureOffscreen` is
    // idempotent: it skips `chrome.offscreen.createDocument` when one
    // already exists. The module-level latch in `offscreen-client.ts`
    // memoises the first-creation promise; if Chromium evicted the
    // offscreen under memory pressure the latch holds a stale resolved
    // promise — see the next-iteration plan in
    // `project_chrome_offscreen_step3_verified.md` for a "reset latch
    // on watchdog miss" follow-up.
    Effect.runFork(ensureOffscreen);
  });
}

// ---------------------------------------------------------------------------
// Service Worker Entry Point
// ---------------------------------------------------------------------------

export default defineBackground({
  type: "module",

  main() {
    setupOffscreenWatchdog();

    const program = Effect.gen(function* () {
      yield* Effect.log("[gerolamino] Background service worker started");
      yield* Effect.log(
        `[gerolamino] offscreen watchdog registered (${OFFSCREEN_WATCHDOG_ALARM}, 5min)`,
      );

      // Boot-time offscreen creation. After Phase D Step 3 stage 3b2 the
      // SW no longer drives bootstrap-sync; the offscreen owns the daemon.
      // No SW caller ever invokes `ensureOffscreen` lazily anymore (the
      // legacy decode-protocol caller was the only path), so without this
      // explicit creation the offscreen never starts and the popup-facing
      // `BroadcastDeltas` relay's `RpcClient.make(OffscreenRpcs)` would
      // hang forever waiting for a BroadcastChannel server that doesn't
      // exist. `ensureOffscreen` is idempotent across re-invocations.
      yield* Effect.log("[gerolamino] Ensuring offscreen daemon at SW boot");
      yield* ensureOffscreen;

      yield* Effect.log("[gerolamino] Launching RPC server (chrome.runtime.Port transport)");
      yield* Effect.forkDetach(
        Layer.launch(RpcServerLive.pipe(Layer.provideMerge(OffscreenClientLive))),
      );
      yield* awaitChromePortServerListening;
      yield* Effect.log("[gerolamino] Popup Port RPC transport listening");

      // Bootstrap-sync is owned by the offscreen daemon (storage watcher +
      // `RequestRestart` from popup upload). A second SW→offscreen client for
      // boot-time `RequestRestart` duplicated BC listeners and broke upload Ping.

      yield* Effect.log(
        "[gerolamino] Bootstrap-sync runs in the offscreen daemon. " +
          "SW boot is complete; popup deltas relay through SubscribeAtomDeltas.",
      );
    });

    Effect.runFork(program.pipe(Effect.provide(TestLogBufferLayer)));
  },
});
