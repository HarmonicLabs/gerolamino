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
 * Not a pass/fail test — emits a summary at the end.
 */
import { test, expect } from "./fixtures.ts";

test.describe("Bootstrap trace (long-running)", () => {
  test.skip(!process.env.RUN_BOOTSTRAP_TRACE, "Set RUN_BOOTSTRAP_TRACE=1 to run");

  test("observe SW console for 5 minutes", async ({ openPopup, swLogs }) => {
    test.setTimeout(6 * 60 * 1000);

    const popup = await openPopup();
    await popup.waitForLoadState("domcontentloaded");

    const OBSERVE_MS = 5 * 60 * 1000;
    const start = Date.now();
    console.log(`\n[trace] Observing SW for ${OBSERVE_MS / 1000}s. Live logs:\n`);

    let printed = 0;
    while (Date.now() - start < OBSERVE_MS) {
      while (printed < swLogs.length) {
        const l = swLogs[printed]!;
        console.log(`[SW ${l.type}] ${l.text}`);
        printed += 1;
      }
      await popup.waitForTimeout(500);
    }

    console.log("\n=== TRACE SUMMARY ===");
    console.log(`Total SW log messages: ${swLogs.length}`);
    const errors = swLogs.filter((l) => l.type === "error");
    const warnings = swLogs.filter((l) => l.type === "warning");
    console.log(`  errors:   ${errors.length}`);
    console.log(`  warnings: ${warnings.length}`);
    if (errors.length > 0) {
      console.log("\nErrors:");
      for (const e of errors.slice(0, 10)) console.log(`  ${e.text}`);
    }

    expect(swLogs.length).toBeGreaterThan(0);
  });
});
