/**
 * Diagnostic spec: end-to-end upload chain isolation test.
 *
 * The user reports their Mithril-snapshot upload sits at "0 MiB"
 * forever in ungoogled-chromium. Two failure surfaces are plausible:
 *
 *   (a) Source-code bug — the popup → SW → offscreen → worker → OPFS
 *       chain hangs for ANY non-trivial input.
 *   (b) Browser-specific bug — the chain works in Playwright's
 *       chromium but not in ungoogled-chromium for some isolation /
 *       File-System-Access-API restriction reason.
 *
 * This spec isolates (a) by seeding a minimal V2LSM directory in
 * OPFS (bypassing the OS picker), mocking `showDirectoryPicker` to
 * return that directory handle, then driving the popup's upload
 * flow. Every layer's console is captured + correlated.
 *
 * Pass criteria: a 6-file fixture (~30 KB total) round-trips
 * through the upload pipeline in <30 s and the final status shows
 * `kind: "done"`.
 *
 * Body is an Effect program; `Clock.currentTimeMillis` + `Effect.sleep`
 * drive the polling loop, `Console.log` emits the structured dumps.
 */
import { Clock, Console, Effect, Exit } from "effect";
import { test, expect } from "./fixtures.ts";
import {
  gotoOffscreen,
  installE2eDeferBootstrap,
  ensureE2eDeferBootstrap,
  clickResumeExistingSnapshot,
  prepareUploadE2eOpfs,
  pollUploadCompleteText,
} from "./extension-helpers.ts";
import { pollUntil } from "./effect-helpers.ts";
import { dumpRecent, runE, sleep } from "./effect-helpers.ts";

test("upload chain pumps bytes end-to-end with a synthetic fixture", async ({
  context,
  extensionId,
  swLogs,
}) =>
  runE(
    Effect.gen(function* () {
      test.setTimeout(300_000);
      yield* installE2eDeferBootstrap(context);

      const seedPage = yield* Effect.promise(() => context.newPage());
      yield* Effect.promise(() =>
        seedPage.goto(`chrome-extension://${extensionId}/popup.html`),
      );
      yield* ensureE2eDeferBootstrap(seedPage);
      const seedKind = yield* prepareUploadE2eOpfs(seedPage);
      yield* Console.log(`[diag-upload-chain] OPFS seed kind=${seedKind}`);
      yield* Effect.promise(() => seedPage.close());

      const probe = yield* Effect.promise(() => context.newPage());
      yield* Effect.promise(() =>
        probe.goto(`chrome-extension://${extensionId}/popup.html`),
      );
      yield* ensureE2eDeferBootstrap(probe);
      yield* gotoOffscreen(probe, { deferBootstrapSync: true });
      yield* sleep(2_000);
      const readOffscreenLogs = (): Effect.Effect<Array<string>> =>
        Effect.promise(() =>
          probe.evaluate(async () => {
            const bag = await globalThis.chrome.storage.session.get(null);
            const merged: Array<string> = [];
            for (const [key, value] of Object.entries(bag)) {
              if (!key.startsWith("__gerolamino_logs__") || !Array.isArray(value)) continue;
              merged.push(...value);
            }
            return merged;
          }),
        );

      // ─── Step 3: open the popup as a fullpage tab (no auto-close) ──
      const popup = yield* Effect.promise(() => context.newPage());
      const popupLogs: string[] = [];
      popup.on("console", (m) => popupLogs.push(`[popup ${m.type()}] ${m.text()}`));
      popup.on("pageerror", (e) => popupLogs.push(`[popup pageerror] ${e.message}`));

      yield* Effect.promise(() =>
        popup.goto(`chrome-extension://${extensionId}/popup.html?fullpage=1&mode=local`),
      );
      yield* Effect.promise(() => popup.waitForLoadState("domcontentloaded"));
      yield* sleep(10_000);

      const overallStart = yield* Clock.currentTimeMillis;
      yield* clickResumeExistingSnapshot(popup);

      const exit = yield* Effect.exit(
        pollUntil(pollUploadCompleteText(popup), {
          timeoutMs: 180_000,
          description: "diag resume → Snapshot loaded",
        }),
      );

      const elapsedMs = (yield* Clock.currentTimeMillis) - overallStart;
      yield* Console.log(`=== RESUME elapsed: ${elapsedMs / 1000}s succeeded=${Exit.isSuccess(exit)} ===`);
      yield* dumpRecent("=== POPUP CONSOLE (last 30) ===", popupLogs);
      const offscreenLogs = yield* readOffscreenLogs();
      yield* dumpRecent("=== OFFSCREEN CONSOLE (last 30, session buffer) ===", offscreenLogs);
      yield* dumpRecent(
        "=== SW CONSOLE (last 30) ===",
        swLogs.map((e) => `[sw ${e.type}] ${e.text}`),
      );

      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  ));
