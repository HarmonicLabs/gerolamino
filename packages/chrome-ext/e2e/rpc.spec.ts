/**
 * Streaming-RPC tests.
 *
 * Verifies the post-refactor wire: SW publishes JSON delta strings to
 * `PubSub<string>` on a 100 ms cadence; the popup consumes them via the
 * `BroadcastDeltas` streaming RPC over `chrome.runtime.connect({name:
 * "rpc"})`. Each delta is fed to the dashboard's shared `applyDelta`.
 *
 * The SW transport (`rpc-transport.ts`) logs `Client N connected` and
 * `Client N disconnected` per accept/disconnect — those lines are the
 * observable proof that the Port lifecycle is wired correctly.
 *
 * Each test gets its own context (per-test scope), so the `swLogs`
 * buffer is empty at the start of every test.
 */
import { test, expect } from "./fixtures.ts";

test.describe("Streaming RPC (BroadcastDeltas)", () => {
  test("popup connect emits the SW-side `Client connected` log", async ({ openPopup, swLogs }) => {
    const popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      await expect
        .poll(() => swLogs.some((l) => /Client \d+ connected/.test(l.text)), {
          timeout: 15_000,
        })
        .toBe(true);
    } finally {
      await popup.close();
    }
  });

  test("popup close triggers the SW-side `Client disconnected` log", async ({
    openPopup,
    swLogs,
  }) => {
    const popup = await openPopup();
    await popup.waitForLoadState("domcontentloaded");
    await expect
      .poll(() => swLogs.some((l) => /Client \d+ connected/.test(l.text)), {
        timeout: 15_000,
      })
      .toBe(true);
    await popup.close();
    await expect
      .poll(() => swLogs.some((l) => /Client \d+ disconnected/.test(l.text)), {
        timeout: 15_000,
      })
      .toBe(true);
  });

  test("popup applies the initial-snapshot delta (atoms hydrated)", async ({ openPopup }) => {
    const popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");
      await expect
        .poll(async () => await popup.evaluate(() => document.body.innerText.length), {
          timeout: 15_000,
        })
        .toBeGreaterThan(20);
    } finally {
      await popup.close();
    }
  });

  test("two concurrent popups each get their own port", async ({ openPopup, swLogs }) => {
    const p1 = await openPopup();
    await p1.waitForLoadState("domcontentloaded");
    const p2 = await openPopup();
    await p2.waitForLoadState("domcontentloaded");

    try {
      await expect
        .poll(() => swLogs.filter((l) => /Client \d+ connected/.test(l.text)).length, {
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(2);
    } finally {
      await p1.close();
      await p2.close();
    }
  });
});
