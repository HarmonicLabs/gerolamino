/**
 * Playwright configuration for the Gerolamino Chrome extension's
 * end-to-end test suite.
 *
 * Extensions can only run in `chromium.launchPersistentContext`, so the
 * fixture in `e2e/fixtures.ts` opens that context manually — there's
 * nothing project-level to wire here. Tests run serially because each
 * Playwright run owns one persistent context, and inside that context
 * Chrome only allows one MV3 service worker per `--load-extension` arg.
 *
 * The build target is `.output/chrome-mv3-dev/` (produced by `bunx
 * --bun wxt build --mode development`); run that command before the
 * suite or via the `e2e` script in `package.json`.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  /** Each spec file allows ~60 s for the whole file. The bootstrap-trace
   *  spec opts itself out with `test.setTimeout(6 * 60 * 1000)`. */
  timeout: 60_000,
  /** Persistent contexts launch slowly on NixOS — give them slack. */
  expect: { timeout: 10_000 },
  /** Run all specs in a single worker — extensions need a persistent
   *  context, and parallel persistent contexts confuse Chrome's
   *  --load-extension dance. */
  fullyParallel: false,
  workers: 1,
  /** Retries are turned off because Playwright's persistent-context
   *  teardown can hang for 60 s+ on NixOS, which compounds when
   *  retrying — every "flaky" run we observed was a retry attempt
   *  hanging in cleanup, not a genuine test-body failure. The tests
   *  themselves pass reliably on first run. */
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  /** Capture artefacts on first failure for triage. */
  use: {
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chrome-extension" },
  ],
});
