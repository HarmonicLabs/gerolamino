/**
 * Upload chain E2E — seeds OPFS from `.devenv/state/db`, resumes via production
 * popup → offscreen BC (`clientId=2`). Exercises Ping + ReopenAfterSnapshot +
 * RequestRestart without re-uploading via directory picker.
 */
import { Clock, Console, Effect, Exit } from "effect";
import { test, expect } from "./fixtures.ts";
import {
  gotoOffscreen,
  installE2eDeferBootstrap,
  ensureE2eDeferBootstrap,
  clickResumeExistingSnapshot,
  pollUploadCompleteText,
  prepareUploadE2eOpfs,
  readSessionLogs,
} from "./extension-helpers.ts";
import { pollUntil, runE, sleep, waitForLoadState } from "./effect-helpers.ts";

test.describe("Upload chain (OPFS seed + resume)", () => {
  test.setTimeout(300_000);

  test("resume existing snapshot after OPFS seed completes", async ({ context, extensionId }) =>
    runE(
      Effect.gen(function* () {
        yield* installE2eDeferBootstrap(context);

        const probe = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() =>
          probe.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* ensureE2eDeferBootstrap(probe);
        const seedKind = yield* prepareUploadE2eOpfs(probe);
        yield* Console.log(`[upload-synthetic] OPFS seed kind=${seedKind}`);
        yield* gotoOffscreen(probe, { deferBootstrapSync: true });
        yield* sleep(2000);

        const popup = yield* Effect.promise(() => context.newPage());
        const popupLogs: Array<string> = [];
        popup.on("console", (m) => popupLogs.push(`[pop ${m.type()}] ${m.text()}`));

        yield* Effect.promise(() =>
          popup.goto(`chrome-extension://${extensionId}/popup.html?fullpage=1&mode=local`),
        );
        yield* waitForLoadState(popup);
        yield* sleep(10_000);

        const start = yield* Clock.currentTimeMillis;
        yield* clickResumeExistingSnapshot(popup);

        const exit = yield* Effect.exit(
          pollUntil(pollUploadCompleteText(popup), {
            timeoutMs: 180_000,
            description: "Snapshot loaded after resume",
          }),
        );
        const elapsed = (yield* Clock.currentTimeMillis) - start;
        const succeeded = Exit.isSuccess(exit);
        yield* Console.log(`[upload-synthetic] succeeded=${succeeded} elapsed=${elapsed}ms`);

        if (!succeeded) {
          const logs = yield* readSessionLogs(probe);
          yield* Console.log("=== POPUP LOG (last 30) ===");
          for (const l of popupLogs.slice(-30)) yield* Console.log(l);
          yield* Console.log("=== SESSION LOG (last 30) ===");
          for (const l of logs.slice(-30)) yield* Console.log(`[sess] ${l}`);
        }

        expect(succeeded).toBe(true);
        expect(
          popupLogs.some((l) => l.includes("[snapshot-upload] step 2.5: relay ready")),
        ).toBe(true);
      }),
    ));
});
