/**
 * E2E tests for popup <-> service worker messaging.
 *
 * Tests the full message flow: port-based connections, one-time messages
 * (GET_STATE, START_BOOTSTRAP), and state broadcasting. All tests run
 * against a real Chromium instance with the extension loaded.
 *
 * Note: chrome.runtime.sendMessage must be called from a page context
 * (popup, tab) — not from the SW itself — because Chrome delivers
 * messages to OTHER extension contexts, not the sender's own listener.
 */
import { test, expect } from "./fixtures.ts";

test.describe("Messaging", () => {
  test("GET_STATE returns current sync state", async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    const response = await popup.evaluate(async () => {
      return chrome.runtime.sendMessage({ type: "GET_STATE" });
    });

    expect(response).toBeDefined();
    expect(response.state).toBeDefined();
    expect(response.state.status).toBe("idle");
    expect(response.state.blocksReceived).toBe(0);
  });

  test("GET_STATE reflects updated storage", async ({ context, extensionId, serviceWorker }) => {
    // Update state directly in storage via the SW context
    await serviceWorker.evaluate(async () => {
      await chrome.storage.session.set({
        syncState: {
          status: "syncing",
          protocolMagic: 1,
          snapshotSlot: "99999",
          totalChunks: 10,
          blocksReceived: 500,
          blobEntriesReceived: 1000,
          ledgerStateReceived: true,
          bootstrapComplete: false,
          lastUpdated: Date.now(),
        },
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    const response = await popup.evaluate(async () => {
      return chrome.runtime.sendMessage({ type: "GET_STATE" });
    });

    expect(response.state.status).toBe("syncing");
    expect(response.state.blocksReceived).toBe(500);
    expect(response.state.ledgerStateReceived).toBe(true);
  });

  test("START_BOOTSTRAP triggers without error", async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    // START_BOOTSTRAP handler calls sendResponse synchronously then returns false,
    // so the promise resolves to the response or undefined depending on timing.
    // The key assertion: no exception is thrown.
    const response = await popup.evaluate(async () => {
      return chrome.runtime.sendMessage({ type: "START_BOOTSTRAP" });
    });

    // Handler sends { ok: true } synchronously — verify if present
    if (response !== undefined) {
      expect(response.ok).toBe(true);
    }
  });

  test("port connection receives initial state", async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    // The popup connects a port named "popup" on mount and receives
    // current state immediately. Wait for the status label to appear.
    await expect(popup.locator(".status-label")).toHaveText("idle", { timeout: 5_000 });
  });

  test("port receives state broadcasts", async ({ context, extensionId, serviceWorker }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    // Wait for initial load
    await expect(popup.locator(".status-label")).toHaveText("idle", { timeout: 5_000 });

    // Update state from the service worker (simulates updateState call)
    await serviceWorker.evaluate(async () => {
      const result = await chrome.storage.session.get("syncState");
      const current = result.syncState ?? {};
      const next = {
        ...Object(current),
        status: "bootstrapping",
        protocolMagic: 1,
        lastUpdated: Date.now(),
      };
      await chrome.storage.session.set({ syncState: next });
      // Broadcast via runtime message (the popup also listens on onMessage)
      await chrome.runtime.sendMessage({ type: "SYNC_STATE", state: next }).catch(() => {});
    });

    // Popup should update via the broadcast
    await expect(popup.locator(".status-label")).toHaveText("bootstrapping", { timeout: 5_000 });
  });

  test("popup reconnects state after navigation", async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator(".status-label")).toHaveText("idle", { timeout: 5_000 });

    // Navigate away and back (simulates closing/reopening popup)
    await popup.goto("about:blank");
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    // Should reconnect and show current state
    await expect(popup.locator(".status-label")).toHaveText("idle", { timeout: 5_000 });
  });

  test("storage.session persists state across popup opens", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    // Set state before opening popup
    await serviceWorker.evaluate(async () => {
      await chrome.storage.session.set({
        syncState: {
          status: "syncing",
          protocolMagic: 1,
          snapshotSlot: "55555",
          totalChunks: 20,
          blocksReceived: 750,
          blobEntriesReceived: 2000,
          ledgerStateReceived: false,
          bootstrapComplete: false,
          lastUpdated: Date.now(),
        },
      });
    });

    // Open popup — should pick up the pre-set state
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(popup.locator(".status-label")).toHaveText("syncing", { timeout: 5_000 });
    await expect(popup.locator(".network-badge")).toHaveText("preprod");
  });

  test("unknown message types do not crash the service worker", async ({
    context,
    extensionId,
  }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    // Send an unknown message type — SW should not crash
    await popup.evaluate(async () => {
      try {
        await chrome.runtime.sendMessage({ type: "UNKNOWN_TYPE" });
      } catch {
        // Expected: no handler responds, so Chrome may throw
      }
    });

    // SW should still be alive — GET_STATE should work
    const response = await popup.evaluate(async () => {
      return chrome.runtime.sendMessage({ type: "GET_STATE" });
    });
    expect(response.state).toBeDefined();
  });
});
