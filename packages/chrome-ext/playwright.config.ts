/**
 * Playwright configuration for the Gerolamino Chrome extension E2E suite.
 *
 * Architecture (aligned with `~/code/reference/playwright`):
 *   - **Runner** (`packages/playwright`) schedules tests across worker processes;
 *     each worker gets a `parallelIndex` (`TEST_PARALLEL_INDEX` env).
 *   - **Browser** (`packages/playwright-core`) launches Chromium; extensions
 *     require `chromium.launchPersistentContext` + `--load-extension` (see
 *     `tests/library/chromium/extensions.spec.ts` and
 *     `tests/extension/extension-fixtures.ts`).
 *   - **Isolation**: one persistent profile per test via `testInfo.outputPath`
 *     (reference pattern) — safe to run workers in parallel; no shared OPFS.
 *
 * Projects:
 *   - `fast` — UI/RPC/SW probes; fully parallel.
 *   - `upload` — OPFS + lsm-worker; serial within project (single-writer).
 *   - `integration` — Mithril ingest + live sync-to-tip; skips when relay down.
 *
 * Build before running: `bunx --bun wxt build --mode development`
 */
import { availableParallelism } from "node:os";
import { defineConfig } from "@playwright/test";

const cpuCount = availableParallelism();

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  /** Default per-test timeout; long specs override with `test.setTimeout`. */
  timeout: 60_000,
  expect: { timeout: 10_000 },
  /** Parallel workers — each gets its own Chromium + extension profile. */
  workers: process.env.CI ? Math.min(2, cpuCount) : Math.min(4, cpuCount),
  fullyParallel: true,
  /** Retries off: NixOS persistent-context teardown can hang 60s+ on retry. */
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "fast",
      testMatch: [
        /rpc\.spec\.ts$/,
        /popup\.spec\.ts$/,
        /setup-form\.spec\.ts$/,
        /dashboard-genesis-hydration\.spec\.ts$/,
        /service-worker\.spec\.ts$/,
        /diag-validate\.spec\.ts$/,
      ],
      fullyParallel: true,
    },
    {
      name: "ui",
      testDir: "./e2e/ui",
      /** Headed locally (WXT / Playwright extension guidance); headless on CI. */
      use: {
        headless: !!process.env.CI,
        viewport: { width: 400, height: 640 },
      },
      fullyParallel: true,
      dependencies: ["fast"],
    },
    {
      name: "ui-headed",
      testDir: "./e2e/ui",
      use: {
        headless: false,
        viewport: { width: 400, height: 640 },
      },
      fullyParallel: true,
      dependencies: ["fast"],
    },
    {
      name: "upload",
      testMatch: [
        /upload-synthetic\.spec\.ts$/,
        /upload-production-bc\.spec\.ts$/,
        /diag-upload-chain\.spec\.ts$/,
        /snapshot-upload\.spec\.ts$/,
      ],
      /** lsm-tree is single-writer — avoid concurrent OPFS uploads. */
      fullyParallel: false,
      workers: 1,
      timeout: 240_000,
    },
    {
      name: "integration",
      testMatch: [/mithril-to-tip\.spec\.ts$/, /sync-to-tip\.spec\.ts$/],
      fullyParallel: false,
      workers: 1,
      timeout: 4 * 60_000,
      /** Run fast smoke first so extension build failures surface early. */
      dependencies: ["fast"],
    },
    {
      name: "integration-relay",
      testMatch: [/mithril-to-tip\.spec\.ts$/, /sync-to-tip\.spec\.ts$/],
      fullyParallel: false,
      workers: 1,
      timeout: 10 * 60_000,
      /** Live relay E2E — no `fast` dependency (avoids localhost-only flakes). */
    },
    {
      name: "manual",
      testMatch: [/bootstrap-trace\.spec\.ts$/, /bootstrap-localhost\.spec\.ts$/],
      fullyParallel: false,
      workers: 1,
    },
  ],
});
