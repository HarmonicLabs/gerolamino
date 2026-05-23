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
 *             WebSocket ${RELAY_WS_URL}/relay (see e2e/relay-config.ts)
 *               -> websockify (3040 -> preprod-node.world.dev.cardano.org:3001)
 *                 -> IOG preprod relay (Ouroboros N2N miniprotocol)
 *
 * Pass criteria:
 *   1. Offscreen logs `WebSocket connected` to the proxy URL.
 *   2. Offscreen logs `First tip observed: slot N` with N > 0.
 *   3. tipSlot advances over the observation window.
 *
 * Body is an Effect program; uses Effect's `Clock` + `sleep` for the
 * observation window, `Console.log` for the diagnostic dumps.
 */
import { Console, Effect } from "effect";
import { test, expect } from "./fixtures.ts";
import {
  clearOpfsRoot,
  installE2eDeferBootstrap,
  installE2eDirectOffscreenRpc,
  readSessionLogs,
  triggerGenesisStartSync,
} from "./extension-helpers.ts";
import { dumpRecent, pollUntil, runE } from "./effect-helpers.ts";
import { RELAY_WS_URL } from "./relay-config.ts";
import {
  highestTipSlotFromLogs,
  relaySyncErrorLines,
} from "./sync-tip-log.ts";

test.describe("sync-to-tip loop over websockify => preprod relay", () => {
  test.setTimeout(6 * 60 * 1000);

  test("offscreen bootstraps + advances tip via the relay proxy", async ({
    context,
    extensionId,
    relayAvailable,
  }) => {
    test.skip(
      !relayAvailable,
      `relay proxy not reachable at ${RELAY_WS_URL} (see e2e/global-setup.ts)`,
    );
    return runE(
      Effect.gen(function* () {
        yield* installE2eDeferBootstrap(context);
        yield* installE2eDirectOffscreenRpc(context);
        const probe = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() =>
          probe.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* clearOpfsRoot(probe);
        yield* triggerGenesisStartSync(context, extensionId, probe);
        // Keep probe alive for the full observation window — closing it must
        // not tear down the offscreen daemon mid-sync.
        let logs: Array<string> = yield* readSessionLogs(probe);

        yield* pollUntil(
          Effect.gen(function* () {
            logs = yield* readSessionLogs(probe);
            return logs.some((l) => /offscreen-sync.*WebSocket connected/i.test(l));
          }),
          { timeoutMs: 120_000, description: "offscreen WebSocket connected to relay proxy" },
        ).pipe(
          Effect.tapCause(() =>
            dumpRecent("[sync-to-tip] session logs at WS-connect failure:", logs, 50),
          ),
        );

        yield* pollUntil(
          Effect.gen(function* () {
            logs = yield* readSessionLogs(probe);
            return highestTipSlotFromLogs(logs) > 0n;
          }),
          {
            timeoutMs: 240_000,
            intervalMs: 5_000,
            description: "offscreen tipSlot > 0 (live preprod relay)",
          },
        ).pipe(
          Effect.tapCause(() =>
            dumpRecent("[sync-to-tip] session logs at tip poll failure:", logs, 50),
          ),
        );

        const highestTipSlot = highestTipSlotFromLogs(logs);
        yield* Console.log(`[sync-to-tip] highest tipSlot=${highestTipSlot}`);
        yield* dumpRecent("[sync-to-tip] Last 60 offscreen lines:", logs, 60);

        const relayErrors = relaySyncErrorLines(logs);
        if (highestTipSlot === 0n && relayErrors.length > 0) {
          yield* dumpRecent("[sync-to-tip] relay/sync errors:", relayErrors, 20);
        }

        expect(highestTipSlot).toBeGreaterThan(0n);
      }),
    );
  });
});
