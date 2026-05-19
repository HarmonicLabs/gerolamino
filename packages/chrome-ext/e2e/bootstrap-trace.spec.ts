/**
 * Long-running observation trace — boots the extension, opens the popup
 * (which connects an RPC Port), and tails the SW console for up to 5
 * minutes. Useful for diagnosing real-world bootstrap + relay sync
 * runs against a live server.
 *
 * Skipped by default. Run explicitly:
 *
 *   bunx --bun playwright test e2e/bootstrap-trace.spec.ts --headed
 *
 * Not a pass/fail test — emits a summary at the end. Test body is an
 * Effect program using `Clock.currentTimeMillis` + `Effect.sleep`.
 */
import { Clock, Console, Effect } from "effect";
import { test, expect } from "./fixtures.ts";
import { dumpRecent, runE, sleep, waitForLoadState, withPage } from "./effect-helpers.ts";

test.describe("Bootstrap trace (long-running)", () => {
  test.skip(!process.env["RUN_BOOTSTRAP_TRACE"], "Set RUN_BOOTSTRAP_TRACE=1 to run");

  test("observe SW console for 5 minutes", async ({ openPopup, swLogs }) => {
    test.setTimeout(6 * 60 * 1000);

    return runE(
      withPage(openPopup, (popup) =>
        Effect.gen(function* () {
          yield* waitForLoadState(popup);

          const OBSERVE_MS = 5 * 60 * 1000;
          const start = yield* Clock.currentTimeMillis;
          yield* Console.log(`\n[trace] Observing SW for ${OBSERVE_MS / 1000}s. Live logs:\n`);

          let printed = 0;
          for (;;) {
            const now = yield* Clock.currentTimeMillis;
            if (now - start >= OBSERVE_MS) break;
            while (printed < swLogs.length) {
              const l = swLogs[printed]!;
              yield* Console.log(`[SW ${l.type}] ${l.text}`);
              printed += 1;
            }
            yield* sleep(500);
          }

          yield* Console.log("\n=== TRACE SUMMARY ===");
          yield* Console.log(`Total SW log messages: ${swLogs.length}`);
          const errors = swLogs.filter((l) => l.type === "error");
          const warnings = swLogs.filter((l) => l.type === "warning");
          yield* Console.log(`  errors:   ${errors.length}`);
          yield* Console.log(`  warnings: ${warnings.length}`);
          if (errors.length > 0) {
            yield* dumpRecent("\nErrors (first 10):", errors.slice(0, 10), 10);
          }

          expect(swLogs.length).toBeGreaterThan(0);
        }),
      ),
    );
  });
});
