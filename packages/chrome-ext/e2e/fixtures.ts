/**
 * Playwright test fixtures for Chrome extension E2E testing.
 *
 * Provides:
 * - `context` — BrowserContext with the extension loaded via persistent context
 * - `extensionId` — The dynamically-assigned chrome-extension:// ID
 * - `serviceWorker` — The extension's MV3 service worker handle
 *
 * The extension is built by WXT into .output/chrome-mv3/.
 * Run `bun run build` before running E2E tests.
 *
 * On NixOS, Playwright's bundled Chromium lacks shared libraries. We resolve
 * the system Chromium via `which chromium` or the CHROMIUM_PATH env var.
 */
import { test as base, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { execSync } from "child_process";
import path from "path";

/** Path to the built extension (WXT output). */
const EXTENSION_PATH = path.join(import.meta.dirname, "../.output/chrome-mv3");

/** Resolve the Chromium executable — prefer env var, then system PATH. */
function resolveChromium(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    return execSync("which chromium", { encoding: "utf-8" }).trim();
  } catch {
    try {
      return execSync("which chromium-browser", { encoding: "utf-8" }).trim();
    } catch {
      throw new Error(
        "Chromium not found. Install via nixpkgs or set CHROMIUM_PATH.",
      );
    }
  }
}

const CHROMIUM_PATH = resolveChromium();

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
}>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      executablePath: CHROMIUM_PATH,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-sandbox",
        "--disable-gpu",
      ],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) {
      sw = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    }
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    const extensionId = serviceWorker.url().split("/")[2];
    await use(extensionId);
  },
});

export const expect = test.expect;
