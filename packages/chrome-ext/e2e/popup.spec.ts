/**
 * E2E tests for the extension popup UI.
 *
 * Tests the Solid.js popup in a real Chromium instance with the
 * extension loaded. Verifies rendering, state display, and user
 * interactions against the actual background service worker.
 */
import { test, expect } from "./fixtures.ts";

test.describe("Popup UI", () => {
  test("opens and renders the header", async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(popup.locator("h1")).toHaveText("Gerolamino");
    await expect(popup.locator(".subtitle")).toHaveText("In-browser Cardano node");
  });

  test("shows idle status on initial load", async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(popup.locator(".status-label")).toHaveText("idle");
  });

  test("displays start button when idle", async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    const startBtn = popup.locator(".start-btn");
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toHaveText("Start Bootstrap");
  });

  test("hides stats section when idle", async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(popup.locator(".stats")).not.toBeVisible();
  });

  test("shows stats when state is not idle", async ({ context, extensionId, serviceWorker }) => {
    // Patch storage to simulate a non-idle state
    await serviceWorker.evaluate(async () => {
      await chrome.storage.session.set({
        syncState: {
          status: "bootstrapping",
          protocolMagic: 1,
          snapshotSlot: "12345678",
          totalChunks: 42,
          blocksReceived: 100,
          blobEntriesReceived: 5000,
          ledgerStateReceived: false,
          bootstrapComplete: false,
          lastUpdated: Date.now(),
        },
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    // Start button should be hidden
    await expect(popup.locator(".start-btn")).not.toBeVisible();

    // Stats section should be visible with correct values
    await expect(popup.locator(".stats")).toBeVisible();
    await expect(popup.locator(".status-label")).toHaveText("bootstrapping");
    await expect(popup.locator(".stat-row").filter({ hasText: "Snapshot Slot" })).toBeVisible();
    await expect(popup.locator(".stat-row").filter({ hasText: "Blocks" })).toBeVisible();
    await expect(popup.locator(".stat-row").filter({ hasText: "UTxO Entries" })).toBeVisible();
    await expect(
      popup.locator(".stat-row").filter({ hasText: "Ledger State" }).locator(".stat-value"),
    ).toHaveText("pending");
    await expect(
      popup.locator(".stat-row").filter({ hasText: "Bootstrap" }).locator(".stat-value"),
    ).toHaveText("in progress");
  });

  test("shows preprod badge when protocolMagic is 1", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.session.set({
        syncState: {
          status: "syncing",
          protocolMagic: 1,
          snapshotSlot: "0",
          totalChunks: 0,
          blocksReceived: 0,
          blobEntriesReceived: 0,
          ledgerStateReceived: false,
          bootstrapComplete: false,
          lastUpdated: Date.now(),
        },
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(popup.locator(".network-badge")).toHaveText("preprod");
  });

  test("shows error box when lastError is set", async ({ context, extensionId, serviceWorker }) => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.session.set({
        syncState: {
          status: "error",
          protocolMagic: 1,
          snapshotSlot: "0",
          totalChunks: 0,
          blocksReceived: 0,
          blobEntriesReceived: 0,
          ledgerStateReceived: false,
          bootstrapComplete: false,
          lastError: "WebSocket connection failed",
          lastUpdated: Date.now(),
        },
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(popup.locator(".error-box")).toBeVisible();
    await expect(popup.locator(".error-box")).toContainText("WebSocket connection failed");
  });

  test("displays footer with last-updated timestamp", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const now = Date.now();
    await serviceWorker.evaluate(async (ts) => {
      await chrome.storage.session.set({
        syncState: {
          status: "syncing",
          protocolMagic: 1,
          snapshotSlot: "0",
          totalChunks: 0,
          blocksReceived: 0,
          blobEntriesReceived: 0,
          ledgerStateReceived: false,
          bootstrapComplete: false,
          lastUpdated: ts,
        },
      });
    }, now);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    const footer = popup.locator(".footer");
    await expect(footer).toBeVisible();
    // Should contain a time string (not the placeholder "—")
    await expect(footer).not.toContainText("—");
  });

  test("shows completed bootstrap state", async ({ context, extensionId, serviceWorker }) => {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.session.set({
        syncState: {
          status: "syncing",
          protocolMagic: 1,
          snapshotSlot: "65000000",
          totalChunks: 1500,
          blocksReceived: 3200,
          blobEntriesReceived: 42000,
          ledgerStateReceived: true,
          bootstrapComplete: true,
          lastUpdated: Date.now(),
        },
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(
      popup.locator(".stat-row").filter({ hasText: "Ledger State" }).locator(".stat-value"),
    ).toHaveText("received");
    await expect(
      popup.locator(".stat-row").filter({ hasText: "Bootstrap" }).locator(".stat-value"),
    ).toHaveText("complete");
  });
});
