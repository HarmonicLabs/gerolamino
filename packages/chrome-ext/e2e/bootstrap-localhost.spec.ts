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
 *
 * Test bodies are Effect programs; logs are read out of the live buffer
 * via Effect-bound predicates.
 */
import { Clock, Console, Effect } from "effect";
import { test } from "./fixtures.ts";
import {
  pollSync,
  pollUntil,
  runE,
  swLogsMatch,
  waitForLoadState,
  withPage,
  type SwLog,
} from "./effect-helpers.ts";

const BOOTSTRAP_INFO_URL = "http://localhost:3040/info";

const reachable: Effect.Effect<boolean> = Effect.promise(() =>
  fetch(BOOTSTRAP_INFO_URL, { signal: AbortSignal.timeout(2_000) })
    .then((res) => res.ok)
    .catch(() => false),
);

const phaseFromLogs = (
  logs: ReadonlyArray<SwLog>,
): { phase: string; blocks: number; utxos: number } => {
  let blocks = 0;
  let utxos = 0;
  let phase = "init";
  for (const l of logs) {
    const t = l.text;
    if (t.includes("WebSocket connected")) phase = "connected";
    else if (t.includes("Ledger state:")) phase = "ledger-state";
    else if (t.includes("Offscreen decode complete")) phase = "ledger-decoded";
    else if (t.includes("Bootstrap completed") || t.includes("Complete frame"))
      phase = "complete";
    const utxoMatch = /UTxO entries: (\d+)/.exec(t);
    if (utxoMatch) utxos = Math.max(utxos, parseInt(utxoMatch[1]!, 10));
    const blockMatch = /Blocks: (\d+)/.exec(t);
    if (blockMatch) blocks = Math.max(blocks, parseInt(blockMatch[1]!, 10));
  }
  return { phase, blocks, utxos };
};

test.describe("Bootstrap against localhost", () => {
  // Allow the popup to keep the SW awake while pulling ~17 GB. The
  // user-stated budget is 5–6 min ideal, 10–15 min max; tying the
  // Playwright timeout to 16 min gives the heartbeat one final tick
  // past the 15-min ceiling so a borderline run reports cleanly
  // rather than terminating mid-tick.
  test.setTimeout(16 * 60_000);

  test("popup pulls the full snapshot to Complete within the deadline", async ({
    swLogs,
    openPopup,
  }) =>
    runE(
      Effect.gen(function* () {
        const isUp = yield* reachable;
        if (!isUp) {
          test.skip(true, "bootstrap server not running on localhost:3040");
          return;
        }
        const start = yield* Clock.currentTimeMillis;
        yield* withPage(openPopup, (popup) =>
          Effect.gen(function* () {
            yield* waitForLoadState(popup);

            // 1. SW opens the WS to localhost.
            yield* pollUntil(
              pollSync(() =>
                swLogsMatch(swLogs, /ws:\/\/(localhost|127\.0\.0\.1):3040\/bootstrap/),
              ),
              { timeoutMs: 30_000, description: "WebSocket opened to localhost:3040" },
            );

            // 2. Init + Ledger state arrive within 30 s.
            yield* pollUntil(pollSync(() => swLogsMatch(swLogs, "Ledger state:")), {
              timeoutMs: 30_000,
              description: "Ledger state log",
            });

            // 3. Final assertion: the SW logs `Bootstrap: Complete` (emitted
            //    by `bootstrap-sync.ts:Complete` handler) within the 15-min
            //    ceiling counted from popup open. Heartbeat reports phase /
            //    block / UTxO counts every 30 s so a stalled run is
            //    debuggable from the live console without trace replay.
            let lastReport = start;
            const reportEvery = 30_000;
            const deadlineMs = 15 * 60_000;
            yield* pollUntil(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                if (now - lastReport > reportEvery) {
                  const elapsed = ((now - start) / 1000).toFixed(1);
                  const { phase, blocks, utxos } = phaseFromLogs(swLogs);
                  yield* Console.log(
                    `[bootstrap-e2e] t=${elapsed}s phase=${phase} blocks=${blocks} utxos=${utxos}`,
                  );
                  lastReport = now;
                }
                return swLogs.some(
                  (l) =>
                    l.text.includes("[bootstrap] Complete:") ||
                    l.text.includes("Bootstrap completed") ||
                    l.text.includes("Complete frame received"),
                );
              }),
              {
                timeoutMs: deadlineMs,
                intervalMs: 1_000,
                description: "Bootstrap reaches Complete",
              },
            );

            const end = yield* Clock.currentTimeMillis;
            const elapsedSec = (end - start) / 1000;
            const { blocks, utxos } = phaseFromLogs(swLogs);
            yield* Console.log(
              `[bootstrap-e2e] DONE in ${elapsedSec.toFixed(1)}s — ${blocks} blocks, ${utxos} UTxOs`,
            );
          }),
        );
      }),
    ));
});
