/**
 * SW boot + lifecycle tests.
 *
 * Verifies the post-refactor SW design (no `chrome.storage.session`
 * bridge, no `SyncStateRef`): the SW spins up, registers the keepalive
 * alarm, listens on `chrome.runtime.onConnect` for the streaming RPC
 * server.
 *
 * Tests run offline by default — the SW's bootstrap pipeline tries to
 * connect to `ws://178.156.252.81:3040`. When that's unreachable
 * (CI / no-network environments) the pipeline retries with exponential
 * backoff and emits expected `Sync error` / `Connection failed` log
 * lines. The error-tolerance test below accepts those and rejects only
 * unexpected errors.
 */
import { test, expect } from "./fixtures.ts";

const EXPECTED_ERROR_FRAGMENTS = [
  "WebSocket",
  "Sync error",
  "Connection failed",
  "Bootstrap completed without",
  "Failed to fetch",
  "ws://",
  "wss://",
  "ECONN",
  "timeout",
  "Network",
];

test.describe("Service worker", () => {
  test("loads under chrome-extension:// origin", async ({ serviceWorker }) => {
    expect(serviceWorker.url()).toMatch(/^chrome-extension:\/\/[a-z]{32}\/background\.js$/);
  });

  test("registers the keepalive alarm", async ({ serviceWorker }) => {
    const alarms = await serviceWorker.evaluate(async () => {
      return await globalThis.chrome.alarms.getAll();
    });
    expect(alarms.length).toBeGreaterThan(0);
    expect(alarms.find((a) => a.name === "gerolamino-keepalive")).toBeDefined();
  });

  test("logs the SW-started + RPC-launched lines", async ({ swLogs, serviceWorker }) => {
    // Force a tick of the SW so any queued console messages flush before
    // we poll. This guards against the race where the swLogs listener
    // attaches after the SW already finished its boot logging.
    await serviceWorker.evaluate(() => new Promise((r) => setTimeout(r, 200)));

    await expect
      .poll(() => swLogs.some((l) => l.text.includes("Background service worker started")), {
        timeout: 15_000,
      })
      .toBe(true);
    await expect
      .poll(() => swLogs.some((l) => l.text.includes("Launching RPC server")), {
        timeout: 15_000,
      })
      .toBe(true);
  });

  test("emits no UNEXPECTED console errors during boot", async ({ swLogs, serviceWorker }) => {
    // Give the SW time to settle. WS-failure errors are *expected* when
    // the test machine has no route to the production bootstrap server,
    // so we filter them and only fail on genuinely unexpected lines.
    await serviceWorker.evaluate(() => new Promise((r) => setTimeout(r, 1_500)));
    const isExpected = (text: string) =>
      EXPECTED_ERROR_FRAGMENTS.some((frag) => text.toLowerCase().includes(frag.toLowerCase()));
    const unexpected = swLogs.filter((l) => l.type === "error" && !isExpected(l.text));
    if (unexpected.length > 0) {
      console.log(
        "[debug] Unexpected SW errors:\n" + unexpected.map((e) => "  " + e.text).join("\n"),
      );
    }
    expect(unexpected).toHaveLength(0);
  });
});
