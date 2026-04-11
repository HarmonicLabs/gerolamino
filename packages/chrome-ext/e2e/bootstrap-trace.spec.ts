/**
 * Playwright trace — loads the Chrome extension, observes the background
 * service worker console, and captures bootstrap + relay behavior.
 *
 * Run:  bunx playwright test specs/bootstrap-trace.spec.ts --headed
 */
import { test, expect, chromium } from "@playwright/test";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const EXTENSION_PATH = resolve(import.meta.dirname, "../.output/chrome-mv3");

// NixOS: Playwright's bundled Chromium lacks shared libs — use system Chromium.
// Resolve via `nix shell` if CHROMIUM_PATH not set.
const findChromium = (): string => {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    return execSync("nix shell nixpkgs#chromium -c which chromium", {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "chromium";
  }
};

test("trace bootstrap service worker", async () => {
  const executablePath = findChromium();
  console.log(`Using Chromium: ${executablePath}`);

  // Launch Chromium with the extension loaded
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    executablePath,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--disable-default-apps",
    ],
  });

  // Find the service worker target — MV3 background runs as a service worker
  let swPage = context.serviceWorkers()[0];
  if (!swPage) {
    swPage = await context.waitForEvent("serviceworker", { timeout: 10_000 });
  }

  // Collect all console messages from the service worker
  const logs: string[] = [];
  swPage.on("console", (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    logs.push(text);
    console.log(`[SW] ${text}`);
  });

  // Also capture errors/crashes
  swPage.on("close", () => {
    console.log("[SW] Service worker CLOSED (killed by Chrome?)");
    logs.push("[CLOSED] Service worker terminated");
  });

  // Let the bootstrap run for up to 5 minutes, logging everything
  const OBSERVE_MS = 5 * 60 * 1000;
  console.log(`\nObserving service worker for ${OBSERVE_MS / 1000}s...\n`);

  // Poll chrome.storage.session for state updates every 5 seconds
  const page = context.pages()[0] ?? (await context.newPage());

  // Navigate to extension popup to trigger initial state load
  const extensionId = swPage.url().split("/")[2];
  if (extensionId) {
    await page.goto(`chrome-extension://${extensionId}/popup.html`).catch(() => {});
  }

  const stateHistory: Array<{ ts: number; status: string; blobs: number; blocks: number }> = [];

  const pollInterval = setInterval(async () => {
    try {
      const state = await page.evaluate(async () => {
        const result = await chrome.storage.session.get("syncState");
        return result.syncState;
      });
      if (state) {
        const entry = {
          ts: Date.now(),
          status: state.status,
          blobs: state.blobEntriesReceived ?? 0,
          blocks: state.blocksReceived ?? 0,
        };
        stateHistory.push(entry);
        console.log(
          `[STATE] ${entry.status} | blobs: ${entry.blobs} | blocks: ${entry.blocks}`,
        );
      }
    } catch {
      // Page might have navigated or closed
    }
  }, 5_000);

  // Wait for completion or timeout
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.log("\n[TIMEOUT] Observation period ended");
      resolve();
    }, OBSERVE_MS);

    // Check for completion every second
    const check = setInterval(() => {
      const lastState = stateHistory[stateHistory.length - 1];
      if (lastState?.status === "syncing" || lastState?.status === "error") {
        console.log(`\n[DONE] Reached status: ${lastState.status}`);
        clearTimeout(timeout);
        clearInterval(check);
        // Give it 10 more seconds to observe relay behavior
        setTimeout(resolve, 10_000);
      }
    }, 1_000);
  });

  clearInterval(pollInterval);

  // Print summary
  console.log("\n=== TRACE SUMMARY ===");
  console.log(`Total log messages: ${logs.length}`);
  console.log(`State transitions: ${stateHistory.length}`);
  if (stateHistory.length > 0) {
    const first = stateHistory[0]!;
    const last = stateHistory[stateHistory.length - 1]!;
    console.log(`First state: ${first.status}`);
    console.log(`Last state: ${last.status} (blobs: ${last.blobs}, blocks: ${last.blocks})`);
    const duration = (last.ts - first.ts) / 1000;
    console.log(`Duration: ${duration.toFixed(1)}s`);
  }

  // Check for errors in logs
  const errors = logs.filter(
    (l) => l.includes("[error]") || l.includes("Error") || l.includes("CLOSED"),
  );
  if (errors.length > 0) {
    console.log("\nErrors detected:");
    errors.forEach((e) => console.log(`  ${e}`));
  }

  // Don't assert — this is a trace, not a pass/fail test
  expect(logs.length).toBeGreaterThan(0);

  await context.close();
});
