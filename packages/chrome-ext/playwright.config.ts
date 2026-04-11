/**
 * Playwright config for Chrome extension E2E tests.
 *
 * Extensions require Chromium with a persistent context — they cannot be
 * loaded in ephemeral contexts. On NixOS, we use the system Chromium
 * (from nixpkgs) since Playwright's bundled binary lacks shared libs.
 *
 * Extension is built by WXT into .output/chrome-mv3/ before tests run.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 1, // Extension context launch can be flaky on NixOS
  workers: 1, // Extensions need serial execution (persistent context)
  projects: [
    {
      name: "chrome-extension",
    },
  ],
});
