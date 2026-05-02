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

  // Capability probe: which storage primitives are reachable from the
  // MV3 SW context? `FileSystemSyncAccessHandle.createSyncAccessHandle`
  // is documented as dedicated-worker-only and Chrome enforces that
  // restriction in MV3 SWs even though they ARE worker contexts. The
  // Worker constructor is also unavailable in MV3 SWs. We assert the
  // *shape* of what's reachable so that if Chrome relaxes either
  // restriction, this test trips and we can re-attempt the OPFS-backed
  // SqlClient migration (currently filed under Phase 1 follow-up).
  test("storage capability probe reflects current MV3 SW restrictions", async ({
    serviceWorker,
  }) => {
    const probe = await serviceWorker.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      const file = await dir.getFileHandle("__sw-probe", { create: true });
      let syncHandleOk = false;
      try {
        const handle = await (
          file as FileSystemFileHandle & {
            createSyncAccessHandle: () => Promise<FileSystemSyncAccessHandle>;
          }
        ).createSyncAccessHandle();
        handle.close();
        syncHandleOk = true;
      } catch {
        syncHandleOk = false;
      }
      let writableOk = false;
      try {
        const ws = await file.createWritable();
        await ws.close();
        writableOk = true;
      } catch {
        writableOk = false;
      }
      await dir.removeEntry("__sw-probe");
      return {
        hasOPFS: typeof navigator.storage?.getDirectory === "function",
        hasIndexedDB: typeof globalThis.indexedDB === "object",
        hasMessageChannel: typeof MessageChannel === "function",
        hasWorker: typeof Worker === "function",
        syncHandleOk,
        writableOk,
      } as const;
    });
    // Hard expectations — regressions in any of these would break the
    // SW before they break this assertion.
    expect(probe.hasOPFS).toBe(true);
    expect(probe.hasIndexedDB).toBe(true);
    expect(probe.hasMessageChannel).toBe(true);
    // Soft tracking — these stay false today; if they flip, we want to
    // know so Phase 1 can finally land.
    expect(probe.syncHandleOk).toBe(false);
    expect(probe.hasWorker).toBe(false);
  });
});
