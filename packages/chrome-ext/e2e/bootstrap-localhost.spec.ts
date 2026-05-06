/**
 * Bootstrap-against-localhost E2E.
 *
 * Pre-flight: the bootstrap server must be running locally on
 * `ws://localhost:3040` against the snapshot in `./db`. Start it with:
 *
 *   bun run apps/bootstrap/src/cli.ts serve \
 *     --snapshot-path "$PWD/db" --network preprod \
 *     --lsm-lib "$LIBLSM_BRIDGE_PATH" --port 3040
 *
 * The chrome-ext build must point at that URL — `wxt.config.ts`
 * substitutes `__BOOTSTRAP_URL__` from the `BOOTSTRAP_URL` env var at
 * build time:
 *
 *   BOOTSTRAP_URL=ws://localhost:3040 ENABLE_BOOTSTRAP=true \
 *     bunx --bun wxt build --mode development
 *
 * The test skips itself if the server isn't reachable, so it's safe
 * to leave in the default e2e run.
 */
import { test, expect } from "./fixtures.ts";

const BOOTSTRAP_INFO_URL = "http://localhost:3040/info";

const reachable = async (): Promise<boolean> => {
  try {
    const res = await fetch(BOOTSTRAP_INFO_URL, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

test.describe("Bootstrap against localhost", () => {
  test("popup connects to the local bootstrap server + emits a state delta", async ({
    serviceWorker,
    swLogs,
    openPopup,
  }) => {
    if (!(await reachable())) test.skip(true, "bootstrap server not running on localhost:3040");

    // Confirm the build embedded the localhost URL.
    const probe = await serviceWorker.evaluate(
      () => (globalThis as { __BOOTSTRAP_URL__?: string }).__BOOTSTRAP_URL__ ?? null,
    );
    // (Vite's `define` rewrites identifiers, so the global isn't set —
    // we instead verify by watching the SW's own log output below.)
    void probe;

    const popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");

      // The SW logs `[bootstrap] Initializing WASM...` then
      // `[sync] Opening WebSocket to ws://...`. Wait for the
      // websocket-open log and assert it points at localhost.
      await expect
        .poll(
          () =>
            swLogs.find((l) => l.text.includes("Opening WebSocket to ws://"))?.text ?? "",
          { timeout: 30_000 },
        )
        .toMatch(/ws:\/\/(localhost|127\.0\.0\.1):3040/);

      // Bootstrap-stream Init frame should arrive within ~5s.
      await expect
        .poll(
          () =>
            swLogs.some(
              (l) =>
                l.text.includes("Bootstrap completed") ||
                l.text.includes("Init frame") ||
                l.text.includes("snapshotSlot") ||
                l.text.includes("Ledger state") ||
                l.text.includes("Decoded ExtLedgerState"),
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
    } finally {
      await popup.close();
    }
  });
});
