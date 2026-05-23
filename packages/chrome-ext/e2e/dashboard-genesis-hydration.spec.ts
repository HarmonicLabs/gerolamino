/**
 * Genesis dashboard hydration — guards the SW/offscreen cold-start race that left
 * the popup on atom defaults (`RpcClientDefect: Chrome runtime port disconnected`).
 *
 * Full genesis→tip progression lives in `sync-to-tip.spec.ts` (integration).
 */
import { Effect } from "effect";
import { test, expect } from "./fixtures.ts";
import {
  bootstrapSyncProgressLogged,
  readSessionLogs,
  seedBootstrapSettings,
} from "./extension-helpers.ts";
import { pollUntil, runE, sleep, waitForLoadState } from "./effect-helpers.ts";

const STORAGE_KEY = "gerolamino:bootstrap-settings";
const SEED_JSON = JSON.stringify({ mode: "genesis", serverUrl: "ws://localhost:3040" });

const seedGenesis = (page: import("@playwright/test").Page): Effect.Effect<void> =>
  seedBootstrapSettings(page, { mode: "genesis", serverUrl: "ws://localhost:3040" });

const collectConsole = (page: import("@playwright/test").Page): Array<string> => {
  const lines: Array<string> = [];
  page.on("console", (msg) => {
    lines.push(msg.text());
  });
  return lines;
};

test.describe("Genesis dashboard hydration", () => {
  test("seeded cold open: atom stream hydrates (not stuck on empty defaults)", async ({
    context,
    extensionId,
  }) =>
    runE(
      Effect.gen(function* () {
        const seedPopup = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() =>
          seedPopup.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* waitForLoadState(seedPopup);
        yield* seedGenesis(seedPopup);
        yield* sleep(200);
        yield* Effect.promise(() => seedPopup.close());

        const popup = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() =>
          popup.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* waitForLoadState(popup);
        yield* pollUntil(
          Effect.gen(function* () {
            const len = yield* Effect.promise(() =>
              popup.evaluate(() => document.body.innerText.length),
            );
            return len > 20;
          }),
          { timeoutMs: 30_000, description: "dashboard body hydrates from BroadcastDeltas" },
        );
        yield* Effect.promise(() => popup.close());
      }),
    ));

  test("SW boot race: at most one dashboard Port disconnect warning", async ({
    context,
    extensionId,
  }) => {
    test.setTimeout(120_000);
    return runE(
      Effect.gen(function* () {
        const popup = yield* Effect.promise(() => context.newPage());
        const consoleLines = collectConsole(popup);
        yield* Effect.promise(() =>
          popup.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* waitForLoadState(popup);
        yield* Effect.promise(() =>
          popup.evaluate(
            ([key, value]) =>
              new Promise<void>((resolve) => {
                globalThis.chrome.storage.local.set({ [key]: value }, () => resolve());
              }),
            [STORAGE_KEY, SEED_JSON] as const,
          ),
        );
        yield* Effect.promise(() => popup.reload());
        yield* waitForLoadState(popup);
        yield* pollUntil(
          Effect.gen(function* () {
            const len = yield* Effect.promise(() =>
              popup.evaluate(() => document.body.innerText.length),
            );
            return len > 20;
          }),
          { timeoutMs: 30_000, description: "dashboard hydrates after reload" },
        );
        yield* pollUntil(
          Effect.gen(function* () {
            const logs = yield* readSessionLogs(popup);
            return logs.some(
              (line) =>
                /\[offscreen\] Forking bootstrap-sync/i.test(line) ||
                bootstrapSyncProgressLogged(line),
            );
          }),
          { timeoutMs: 90_000, description: "offscreen bootstrap-sync started after reload" },
        );
        yield* sleep(500);
        const disconnects = consoleLines.filter((line) =>
          /dashboard RPC.*port disconnected/i.test(line),
        );
        yield* Effect.sync(() => {
          expect(disconnects.length).toBeLessThanOrEqual(1);
        });
        yield* Effect.promise(() => popup.close());
      }),
    );
  });
});
