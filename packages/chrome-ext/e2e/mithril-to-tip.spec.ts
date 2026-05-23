/**
 * End-to-end Mithril bootstrap -> sync-to-tip pipeline test.
 *
 * Exercises the full chain in one spec:
 *   1. Seed OPFS from `.devenv/state/db` (slim: active LSM + ledger,
 *      no immutable chunks or frozen snapshot keyops).
 *   2. Seed chrome.storage.local with `mode: "local"` so the offscreen
 *      bootstrap-sync pipeline picks the Mithril path on next boot.
 *   3. Fork bootstrap-sync via storage watcher + `RequestRestart` fallback.
 *   4. Open the popup. Verify the BrowserDashboard:
 *      - Connects via chrome.runtime.connect (SW logs `Client N
 *        connected`).
 *      - Receives delta frames from the offscreen daemon (popup
 *        body shows atom-derived sync state when relay is up).
 *
 * Skips the live sync portion gracefully when the relay proxy isn't
 * reachable (see `e2e/relay-config.ts`). The Mithril-ingest + offscreen-boot +
 * dashboard-render assertions run unconditionally so this spec
 * surfaces regressions in the OPFS pipeline + atom-delta wire even
 * offline.
 */
import { Clock, Console, Effect } from "effect";
import { test, expect } from "./fixtures.ts";
import {
  bootstrapSyncProgressLogged,
  clearOpfsRoot,
  installE2eDeferBootstrap,
  installE2eDirectOffscreenRpc,
  readSessionLogs,
  seedLocalSnapshotForE2e,
  triggerLocalBootstrapAfterSeed,
} from "./extension-helpers.ts";
import {
  dumpRecent,
  pageEvaluate,
  pollUntil,
  runE,
  sleep,
  waitForLoadState,
} from "./effect-helpers.ts";
import { highestTipSlotFromLogs, relaySyncErrorLines } from "./sync-tip-log.ts";

declare global {
  // eslint-disable-next-line no-var
  var __PORT_CONNECT_COUNT__: number;
}

const installPortConnectCounter = () => {
  globalThis.__PORT_CONNECT_COUNT__ = 0;
  const orig = globalThis.chrome.runtime.connect.bind(globalThis.chrome.runtime);
  Object.defineProperty(globalThis.chrome.runtime, "connect", {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof orig>) => {
      globalThis.__PORT_CONNECT_COUNT__ += 1;
      return orig(...args);
    },
  });
};

test.describe("Mithril bootstrap -> sync-to-tip E2E", () => {
  test.setTimeout(8 * 60_000);

  test("offscreen reads OPFS fixture, opens WS, popup dashboard receives deltas", async ({
    context,
    extensionId,
    relayAvailable,
  }) =>
    runE(
      Effect.gen(function* () {
        yield* installE2eDeferBootstrap(context);
        yield* installE2eDirectOffscreenRpc(context);
        const probe = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() =>
          probe.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* clearOpfsRoot(probe);
        const seedKind = yield* seedLocalSnapshotForE2e(probe);
        yield* Console.log(`[mithril-to-tip] OPFS seed kind=${seedKind}`);
        yield* triggerLocalBootstrapAfterSeed(context, extensionId, probe);
        let offscreenLogs: Array<string> = yield* readSessionLogs(probe);

        // ─── Step 5: verify the Mithril-ingest path runs ──────────────
        yield* pollUntil(
          Effect.gen(function* () {
            offscreenLogs = yield* readSessionLogs(probe);
            return offscreenLogs.some(
              (t) =>
                /offscreen-ingest.*OPFS ledger-state/i.test(t) ||
                /offscreen-sync.*OPFS ingest failed/i.test(t) ||
                /offscreen-ingest.*No OPFS ledger-state/i.test(t) ||
                bootstrapSyncProgressLogged(t),
            );
          }),
          {
            timeoutMs: 120_000,
            description: "offscreen OPFS-ingest path logged (success or graceful fallback)",
          },
        ).pipe(
          Effect.tapCause(() =>
            dumpRecent("=== session logs at ingest-poll failure ===", offscreenLogs, 60),
          ),
        );

        // ─── Step 6: pipeline reaches the WS-connect stage ────────────
        yield* pollUntil(
          Effect.gen(function* () {
            offscreenLogs = yield* readSessionLogs(probe);
            return offscreenLogs.some(
              (t) =>
                /offscreen-sync.*WebSocket connected/i.test(t) ||
                /offscreen-sync.*will retry/i.test(t) ||
                /offscreen-sync.*Connecting to relay proxy/i.test(t) ||
                /offscreen-sync.*Connection failed/i.test(t) ||
                bootstrapSyncProgressLogged(t),
            );
          }),
          { timeoutMs: 180_000, description: "offscreen WS-connect attempt logged" },
        );

        // ─── Step 7: open the popup -- BrowserDashboard mounts ────────
        const popup = yield* Effect.promise(() => context.newPage());
        const popupLogs: Array<string> = [];
        popup.on("console", (m) => popupLogs.push(`[${m.type()}] ${m.text()}`));
        popup.on("pageerror", (e) => popupLogs.push(`[pageerror] ${e.message}`));
        yield* Effect.promise(() => popup.addInitScript(installPortConnectCounter));
        yield* Effect.promise(() =>
          popup.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* waitForLoadState(popup);
        yield* sleep(1000);

        // ─── Step 8: popup calls chrome.runtime.connect ────────────────
        yield* pollUntil(
          Effect.gen(function* () {
            const count = yield* Effect.promise(() =>
              popup.evaluate(() => globalThis.__PORT_CONNECT_COUNT__),
            );
            return count > 0;
          }),
          { timeoutMs: 15_000, description: "popup Port-connect counter > 0" },
        ).pipe(
          Effect.tapCause(() =>
            dumpRecent(
              "=== Offscreen log buffer at failure (40) ===",
              offscreenLogs,
              40,
            ),
          ),
        );

        // ─── Step 9: dashboard skeleton + atom deltas when relay up ───
        const finalSnap = yield* pageEvaluate(popup, () => ({
          hasReset: document.querySelector('[data-testid="reset-settings"]') !== null,
          rootChildren: document.getElementById("root")?.childElementCount ?? -1,
          bodyText: document.body.innerText,
        }));
        expect(finalSnap.hasReset).toBe(true);
        expect(finalSnap.rootChildren).toBeGreaterThan(0);

        if (relayAvailable) {
          yield* pollUntil(
            Effect.gen(function* () {
              const snap = yield* pageEvaluate(popup, () => document.body.innerText);
              return /Syncing|Caught Up|Bootstrapping|Connecting/i.test(snap);
            }),
            {
              timeoutMs: 60_000,
              description: "popup dashboard reflects atom-derived node status",
            },
          );

          yield* pollUntil(
            Effect.gen(function* () {
              offscreenLogs = yield* readSessionLogs(probe);
              return highestTipSlotFromLogs(offscreenLogs) > 0n;
            }),
            {
              timeoutMs: 240_000,
              intervalMs: 5_000,
              description: "offscreen tipSlot > 0 after Mithril ingest + relay sync",
            },
          ).pipe(
            Effect.tapCause(() =>
              dumpRecent(
                "=== session logs at Mithril tip poll failure ===",
                offscreenLogs,
                60,
              ),
            ),
          );

          const highestTip = highestTipSlotFromLogs(offscreenLogs);
          yield* Console.log(`[mithril-to-tip] highest tipSlot=${highestTip}`);
          expect(highestTip).toBeGreaterThan(0n);
          const relayErrors = relaySyncErrorLines(offscreenLogs);
          if (relayErrors.length > 0) {
            yield* dumpRecent("[mithril-to-tip] relay/sync errors:", relayErrors, 20);
          }
        }

        const elapsed = yield* Clock.currentTimeMillis;
        yield* Console.log(
          `[mithril-to-tip] reached dashboard-rendered state at t=${elapsed}ms`,
        );
        yield* dumpRecent("=== Offscreen log tail (40) ===", offscreenLogs, 40);
        yield* dumpRecent("=== Popup log tail (15) ===", popupLogs, 15);

        const errors = popupLogs.filter((l) => l.startsWith("[pageerror]"));
        expect(errors).toEqual([]);
      }),
    ));
});
