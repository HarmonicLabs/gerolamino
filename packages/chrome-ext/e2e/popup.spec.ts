/**
 * Popup UI tests.
 *
 * The popup loads `chrome-extension://<id>/popup.html`, which mounts
 * `<BrowserDashboard>` from `entrypoints/popup/dashboard/index.tsx`.
 *
 * Each test opens a fresh popup page and explicitly closes it before
 * exiting. Persistent-context teardown gets stuck if pages are leaked,
 * which manifests as a 60s "Tearing down context" timeout.
 */
import { test, expect } from "./fixtures.ts";

test.describe("Popup", () => {
  test("popup.html is reachable + Solid renders into #root", async ({ openPopup }) => {
    const popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      const rootHtmlLength = await popup.evaluate(
        () => document.getElementById("root")?.innerHTML.length ?? 0,
      );
      expect(rootHtmlLength).toBeGreaterThan(100);
    } finally {
      await popup.close();
    }
  });

  test("dark theme is applied at the document root", async ({ openPopup }) => {
    const popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      const hasDarkClass = await popup.evaluate(() => {
        return document.querySelectorAll<HTMLElement>(".dark").length > 0;
      });
      expect(hasDarkClass).toBe(true);
    } finally {
      await popup.close();
    }
  });

  test("Tailwind utilities are wired (background + foreground tokens)", async ({ openPopup }) => {
    const popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      const tokens = await popup.evaluate(() => ({
        bg: document.querySelectorAll(".bg-background").length,
        fg: document.querySelectorAll(".text-foreground").length,
      }));
      expect(tokens.bg).toBeGreaterThan(0);
      expect(tokens.fg).toBeGreaterThan(0);
    } finally {
      await popup.close();
    }
  });

  test("popup mounts a non-empty dashboard tree", async ({ openPopup }) => {
    const popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      // Brief tick for Solid to settle on initial atom defaults.
      await popup.waitForTimeout(300);
      const elementCount = await popup.evaluate(
        () => document.getElementById("root")?.querySelectorAll("*").length ?? 0,
      );
      // Sanity floor — the Dashboard layout alone produces 30+ DOM nodes.
      expect(elementCount).toBeGreaterThan(20);
    } finally {
      await popup.close();
    }
  });

  test("popup boots an Effect-runFork that connects via Port", async ({ openPopup, swLogs }) => {
    const popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      // The SW logs `[rpc-transport] Client N connected (active=…)` per
      // accepted Port. The popup's `Effect.runFork` should land within
      // a few hundred ms of mount.
      await expect
        .poll(() => swLogs.some((l) => /Client \d+ connected/.test(l.text)), {
          timeout: 15_000,
        })
        .toBe(true);
    } finally {
      await popup.close();
    }
  });
});
