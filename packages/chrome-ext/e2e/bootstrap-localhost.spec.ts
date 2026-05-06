/**
 * Full Mithril bootstrap E2E — pulls the entire ./db snapshot through
 * the chrome-ext SW, asserting that the SW reaches `Complete frame
 * received` (or equivalent terminal log) within the deadline.
 *
 * Pre-flight:
 *   - bootstrap server running on `ws://localhost:3040` against `./db`
 *   - chrome-ext built with `BOOTSTRAP_URL=ws://localhost:3040
 *     ENABLE_BOOTSTRAP=true wxt build --mode development`
 *
 * Skipped automatically when the server isn't reachable so the spec
 * can stay in the default e2e run without flaking on machines that
 * don't have a snapshot.
 */
import { test, expect } from "./fixtures.ts";

const BOOTSTRAP_INFO_URL = "http://localhost:3040/info";

const reachable = async (): Promise<boolean> => {
  try {
    const res = await fetch(BOOTSTRAP_INFO_URL, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
};

const phaseFromLogs = (
  logs: ReadonlyArray<{ readonly text: string }>,
): { phase: string; blocks: number; utxos: number } => {
  let blocks = 0;
  let utxos = 0;
  let phase = "init";
  for (const l of logs) {
    const t = l.text;
    if (t.includes("WebSocket connected")) phase = "connected";
    else if (t.includes("Ledger state:")) phase = "ledger-state";
    else if (t.includes("Offscreen decode complete")) phase = "ledger-decoded";
    else if (t.includes("Bootstrap completed") || t.includes("Complete frame")) phase = "complete";
    const utxoMatch = /UTxO entries: (\d+)/.exec(t);
    if (utxoMatch) utxos = Math.max(utxos, parseInt(utxoMatch[1]!, 10));
    const blockMatch = /Blocks: (\d+)/.exec(t);
    if (blockMatch) blocks = Math.max(blocks, parseInt(blockMatch[1]!, 10));
  }
  return { phase, blocks, utxos };
};

test.describe("Bootstrap against localhost", () => {
  // Allow the popup to keep the SW awake while pulling ~17 GB.
  test.setTimeout(7 * 60_000);

  test("popup pulls the full snapshot to Complete within the deadline", async ({
    swLogs,
    openPopup,
  }) => {
    if (!(await reachable())) test.skip(true, "bootstrap server not running on localhost:3040");

    const start = Date.now();
    const popup = await openPopup();
    try {
      await popup.waitForLoadState("domcontentloaded");

      // 1. SW opens the WS to localhost.
      await expect
        .poll(
          () =>
            swLogs.find((l) => l.text.includes("Opening WebSocket to ws://"))?.text ?? "",
          { timeout: 30_000 },
        )
        .toMatch(/ws:\/\/(localhost|127\.0\.0\.1):3040\/bootstrap/);

      // 2. Init + Ledger state arrive within 30 s.
      await expect
        .poll(() => swLogs.some((l) => l.text.includes("Ledger state:")), { timeout: 30_000 })
        .toBe(true);

      // 3. Heartbeat: log a snapshot every 30 s so the run is debuggable
      //    without trace+screenshot turn-around. `expect.poll` runs the
      //    predicate on a timer; piggy-back the side effect there.
      let lastReport = Date.now();
      const reportEvery = 30_000;

      // 4. Final assertion: the SW logs `Bootstrap completed` (emitted
      //    by `bootstrap-sync.ts:Complete` handler) within the 6-minute
      //    deadline counted from popup open.
      const deadline = 6 * 60_000;
      await expect
        .poll(
          () => {
            const now = Date.now();
            if (now - lastReport > reportEvery) {
              const elapsed = ((now - start) / 1000).toFixed(1);
              const { phase, blocks, utxos } = phaseFromLogs(swLogs);
              // eslint-disable-next-line no-console
              console.log(
                `[bootstrap-e2e] t=${elapsed}s phase=${phase} blocks=${blocks} utxos=${utxos}`,
              );
              lastReport = now;
            }
            return swLogs.some(
              (l) =>
                l.text.includes("Bootstrap completed") ||
                l.text.includes("Complete frame received"),
            );
          },
          { timeout: deadline, intervals: [1_000, 2_000, 5_000] },
        )
        .toBe(true);

      const elapsedSec = (Date.now() - start) / 1000;
      const { blocks, utxos } = phaseFromLogs(swLogs);
      // eslint-disable-next-line no-console
      console.log(
        `[bootstrap-e2e] DONE in ${elapsedSec.toFixed(1)}s — ${blocks} blocks, ${utxos} UTxOs`,
      );
    } finally {
      await popup.close();
    }
  });
});
