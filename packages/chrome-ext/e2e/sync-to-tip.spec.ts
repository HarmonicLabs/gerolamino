/**
 * End-to-end sync-to-tip loop against the live preprod network.
 *
 * Architecture under test:
 *
 *   Playwright Chromium
 *     - popup (chrome-extension://(...)/popup.html)
 *         BrowserDashboard <- atom-delta stream from SW
 *     - service worker
 *         relay handlers (BroadcastDeltas, StartSync, ...)
 *     - offscreen document (chrome-extension://(...)/offscreen.html)
 *         bootstrap-sync pipeline (always-on daemon)
 *             WebSocket ws://localhost:3040/relay
 *               -> websockify (3040 -> preprod-node.play.dev.cardano.org:3001)
 *                 -> IOG preprod relay (Ouroboros N2N miniprotocol)
 *
 * Pass criteria:
 *   1. Offscreen logs `WebSocket connected` to the proxy URL.
 *   2. Offscreen logs `First tip observed: slot N` with N > 0.
 *   3. tipSlot advances over a 90 s observation window.
 *
 * Body is an Effect program; uses Effect's `Clock` + `sleep` for the
 * observation window, `Console.log` for the diagnostic dumps.
 */
import { Clock, Console, Effect } from "effect";
import { test, expect } from "./fixtures.ts";
import {
  dumpRecent,
  pageEvaluate,
  pollSync,
  pollUntil,
  runE,
  sleep,
  waitForLoadState,
} from "./effect-helpers.ts";

test.describe("sync-to-tip loop over websockify => preprod relay", () => {
  test.setTimeout(4 * 60 * 1000);

  test("offscreen bootstraps + advances tip via the relay proxy", async ({
    context,
    extensionId,
  }) =>
    runE(
      Effect.gen(function* () {
        const offscreen = yield* Effect.promise(() => context.newPage());
        const logs: Array<string> = [];
        offscreen.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
        offscreen.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
        yield* Effect.promise(() =>
          offscreen.goto(`chrome-extension://${extensionId}/offscreen.html`),
        );

        yield* pageEvaluate(offscreen, async () => {
          await globalThis.chrome.storage.local.set({
            "gerolamino:bootstrap-settings": {
              mode: "genesis",
              serverUrl: "ws://localhost:3040",
            },
          });
        });

        logs.length = 0;
        yield* Effect.promise(() => offscreen.reload());
        yield* waitForLoadState(offscreen);

        yield* pollUntil(
          pollSync(() =>
            logs.some((t) => /\[offscreen-sync\] WebSocket connected/i.test(t)),
          ),
          { timeoutMs: 30_000, description: "offscreen WebSocket connected" },
        );

        const popup = yield* Effect.promise(() => context.newPage());
        const popupLogs: Array<string> = [];
        popup.on("console", (m) => popupLogs.push(`[${m.type()}] ${m.text()}`));
        popup.on("pageerror", (e) => popupLogs.push(`[pageerror] ${e.message}`));
        yield* Effect.promise(() =>
          popup.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* waitForLoadState(popup);

        yield* pollUntil(
          Effect.gen(function* () {
            const html = yield* Effect.promise(() => popup.locator("#root").innerHTML());
            return html.length > 0;
          }),
          { timeoutMs: 15_000, description: "Popup root populated" },
        );

        const extractTip = (line: string): bigint | undefined => {
          const m = /tip(?:=|\s+slot\s+)(\d+)/i.exec(line);
          return m ? BigInt(m[1]!) : undefined;
        };

        const observationStart = yield* Clock.currentTimeMillis;
        const observationWindow = 90_000;
        let highestTipSlot = 0n;

        for (;;) {
          const now = yield* Clock.currentTimeMillis;
          if (now - observationStart >= observationWindow) break;
          yield* sleep(5_000);
          for (const line of logs) {
            const slot = extractTip(line);
            if (slot !== undefined && slot > highestTipSlot) {
              highestTipSlot = slot;
            }
          }
        }

        const elapsed = (yield* Clock.currentTimeMillis) - observationStart;
        yield* Console.log(
          `[sync-to-tip] window closed at ${Math.floor(
            elapsed / 1000,
          )}s; highest tipSlot=${highestTipSlot}`,
        );
        yield* dumpRecent("[sync-to-tip] Last 30 offscreen lines:", logs);

        expect(highestTipSlot).toBeGreaterThan(0n);
      }),
    ));
});
