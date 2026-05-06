/**
 * SetupForm E2E — first-open form picks a bootstrap mode, the choice
 * persists to `chrome.storage.local`, and the popup re-renders into
 * the dashboard.
 *
 * The harness is split across the three modes:
 *
 *   1. **first-open shows the form** — `chrome.storage.local` is empty
 *      on a fresh persistent context, so the popup must render
 *      `<SetupForm>` (data-testid="mode-remote"). No SW interaction
 *      yet — the SW reads the same key on its own startup, but the
 *      popup is the only thing under assertion here.
 *
 *   2. **picking "genesis" persists the choice** — clicking
 *      `data-testid="mode-genesis"` then `data-testid="submit"` writes
 *      `{ mode: "genesis", … }` into the storage key. The popup
 *      re-renders into the dashboard. We re-open the popup and assert
 *      the form is gone.
 *
 *   3. **picking "remote" with a URL persists the URL** — the URL
 *      input is type-checked client-side (must start with `ws://`).
 *      We assert the resulting storage shape so the SW would pick it
 *      up on next start.
 *
 * Reachability of the bootstrap server isn't asserted — that's
 * `bootstrap-localhost.spec.ts`'s job. This spec proves the
 * popup-side wiring and the storage round-trip, in isolation.
 */
import { test, expect } from "./fixtures.ts";

const STORAGE_KEY = "gerolamino:bootstrap-settings";

const readStoredSettings = (page: import("@playwright/test").Page) =>
  page.evaluate(
    (key) =>
      new Promise<unknown>((resolve) => {
        globalThis.chrome.storage.local.get(key, (result) => resolve(result[key]));
      }),
    STORAGE_KEY,
  );

const clearStoredSettings = (page: import("@playwright/test").Page) =>
  page.evaluate(
    (key) =>
      new Promise<void>((resolve) => {
        globalThis.chrome.storage.local.remove(key, () => resolve());
      }),
    STORAGE_KEY,
  );

test.describe("Popup setup form", () => {
  test("first open renders the form (no persisted settings yet)", async ({ openPopup }) => {
    const popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      // Storage starts empty in a fresh persistent context, so the form
      // must mount.
      await expect(popup.getByTestId("mode-remote")).toBeVisible({ timeout: 10_000 });
      await expect(popup.getByTestId("mode-local")).toBeVisible();
      await expect(popup.getByTestId("mode-genesis")).toBeVisible();
      await expect(popup.getByTestId("submit")).toBeVisible();
    } finally {
      await popup.close();
    }
  });

  test("picking genesis persists `{ mode: 'genesis' }` and dismisses the form", async ({
    openPopup,
  }) => {
    let popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      await clearStoredSettings(popup);
      // The popup mounted before we cleared storage, so it may have
      // captured a stale `loadSettings` result. Close + re-open to
      // pick up the cleared state. (`popup.reload()` was flaky on
      // chrome-extension:// URLs — extension contexts can capture the
      // wrong serviceWorker handle.)
      await popup.close();
      popup = await openPopup();
      await popup.waitForLoadState("domcontentloaded");
      await expect(popup.getByTestId("mode-genesis")).toBeVisible({ timeout: 10_000 });

      await popup.getByTestId("mode-genesis").click();
      await popup.getByTestId("submit").click();

      await expect
        .poll(() => readStoredSettings(popup), { timeout: 5_000 })
        .toMatchObject({ mode: "genesis" });
    } finally {
      await popup.close();
    }

    // Re-open the popup; the form should NOT mount because the choice
    // is now persisted.
    popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      // Wait long enough for the loadSettings promise to resolve.
      await popup.waitForTimeout(500);
      await expect(popup.getByTestId("submit")).toHaveCount(0);
    } finally {
      await popup.close();
    }
  });

  test("picking remote persists the URL", async ({ openPopup }) => {
    let popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      await clearStoredSettings(popup);
      await popup.close();
      popup = await openPopup();
      await popup.waitForLoadState("domcontentloaded");
      await expect(popup.getByTestId("mode-remote")).toBeVisible({ timeout: 10_000 });

      await popup.getByTestId("mode-remote").click();
      const url = popup.getByTestId("server-url");
      await url.fill("ws://localhost:3040");
      await popup.getByTestId("submit").click();

      await expect
        .poll(() => readStoredSettings(popup), { timeout: 5_000 })
        .toMatchObject({ mode: "remote", serverUrl: "ws://localhost:3040" });
    } finally {
      await popup.close();
    }
  });

  test("rejects a malformed remote URL with an error", async ({ openPopup }) => {
    let popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      await clearStoredSettings(popup);
      await popup.close();
      popup = await openPopup();
      await popup.waitForLoadState("domcontentloaded");
      await expect(popup.getByTestId("mode-remote")).toBeVisible({ timeout: 10_000 });

      await popup.getByTestId("mode-remote").click();
      await popup.getByTestId("server-url").fill("not-a-url");
      await popup.getByTestId("submit").click();

      await expect(popup.getByTestId("error")).toBeVisible({ timeout: 2_000 });
      await expect(popup.getByTestId("error")).toContainText(/ws:\/\/|wss:\/\//);
      // Storage stays untouched.
      await expect.poll(() => readStoredSettings(popup), { timeout: 1_000 }).toBeUndefined();
    } finally {
      await popup.close();
    }
  });
});
