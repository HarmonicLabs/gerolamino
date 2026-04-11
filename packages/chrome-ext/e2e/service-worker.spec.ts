/**
 * E2E tests for the extension's background service worker.
 *
 * Tests service worker lifecycle, state management, and message handling
 * in a real Chromium instance with the extension loaded.
 */
import { test, expect } from "./fixtures.ts";

test.describe("Service Worker", () => {
  test("loads and runs", async ({ serviceWorker }) => {
    // Service worker should be running and accessible
    expect(serviceWorker.url()).toMatch(/^chrome-extension:\/\//);
  });

  test("initializes sync state in chrome.storage.session", async ({ serviceWorker }) => {
    // The SW sets INITIAL_STATE on startup — poll until it's available
    const state = await serviceWorker.evaluate(async () => {
      const result = await chrome.storage.session.get("syncState");
      return result.syncState;
    });

    expect(state).toBeDefined();
    expect(state).toHaveProperty("status", "idle");
    expect(state).toHaveProperty("protocolMagic", 0);
    expect(state).toHaveProperty("blocksReceived", 0);
    expect(state).toHaveProperty("bootstrapComplete", false);
  });

  test("responds to GET_STATE message", async ({ context, extensionId }) => {
    // sendMessage must come from a page context — the SW's own onMessage
    // listener doesn't receive messages sent from within the SW itself.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    const response = await popup.evaluate(async () => {
      return chrome.runtime.sendMessage({ type: "GET_STATE" });
    });

    expect(response.state).toBeDefined();
    expect(response.state.status).toBe("idle");
  });

  test("survives suspension and restart", async ({ context, serviceWorker }) => {
    // Get initial state timestamp
    const initialState = await serviceWorker.evaluate(async () => {
      const result = await chrome.storage.session.get("syncState");
      return result.syncState;
    });
    expect(initialState).toBeDefined();

    // Use CDP to stop the service worker (simulates Chrome's idle suspension)
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);

    let versionId: string | undefined;
    let scopeURL: string | undefined;
    let runningStatus: string | undefined;

    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }: any) => {
      const v = versions[0];
      if (v) {
        versionId = v.versionId;
        runningStatus = v.runningStatus;
      }
    });
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }: any) => {
      if (registrations.length) scopeURL = registrations[0].scopeURL;
    });

    await cdp.send("ServiceWorker.enable");
    await expect.poll(() => versionId && scopeURL, { timeout: 5_000 }).toBeTruthy();

    // Stop the worker
    await cdp.send("ServiceWorker.stopWorker", { versionId: versionId ?? "" });
    await expect.poll(() => runningStatus, { timeout: 5_000 }).toBe("stopped");

    // Restart the worker
    await cdp.send("ServiceWorker.startWorker", { scopeURL: scopeURL ?? "" });
    await expect.poll(() => runningStatus, { timeout: 5_000 }).toBe("running");

    // State should survive restart (persisted in chrome.storage.session)
    const restoredState = await serviceWorker.evaluate(async () => {
      const result = await chrome.storage.session.get("syncState");
      return result.syncState;
    });
    expect(restoredState).toBeDefined();
    expect(restoredState).toHaveProperty("status");

    await page.close();
  });
});
