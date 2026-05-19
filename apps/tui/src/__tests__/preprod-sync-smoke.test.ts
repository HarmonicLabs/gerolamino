/**
 * Smoke test — TUI sync-to-tip against live preprod.
 *
 * Gated on `CARDANO_NODE_HOST` (same env var that controls
 * `packages/miniprotocols/src/__tests__/preprod.test.ts` via the
 * `hasNetwork` exclusion in `vitest.config.ts`). The test is skipped
 * locally + in CI's `test` job; CI's `e2e` job sets the env so it
 * runs as the canonical regression gate for the live-sync path.
 *
 * Approach: spawn the TUI in `--headless --genesis --network preprod`
 * mode, parse its `dashboard { ... }` JSON-log lines, and assert the
 * first tick with `blocks > 0` AND `tipSlot > 0` lands within 30 s.
 * On a healthy preprod relay it lands in <12 s (per
 * `project_tui_sync_verified.md`).
 *
 * The TUI process is killed once the assertion fires — we don't soak
 * for a fixed wallclock, so the test passes fast on a healthy network
 * and fails clearly on stall.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const CARDANO_NODE_HOST = process.env["CARDANO_NODE_HOST"];

// `import.meta.dir` is undefined when this file runs through vitest +
// Vite's transform pipeline (Bun's runtime gives it a value, but the
// Vite-transformed module doesn't). `import.meta.url` IS always
// populated, so derive the directory from that.
const HERE = dirname(fileURLToPath(import.meta.url));
const TUI_ENTRY = resolve(HERE, "..", "index.ts");

describe.runIf(CARDANO_NODE_HOST !== undefined)("TUI live preprod sync", () => {
  it("pulls non-genesis blocks from preprod within 30s", async () => {
    const dataDir = `/tmp/gerolamino-smoke-${Date.now()}`;
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        TUI_ENTRY,
        "start",
        "--headless",
        "--genesis",
        "--network",
        "preprod",
        "--data-dir",
        dataDir,
      ],
      // Effect.log writes to stderr by default; we merge stderr into
      // stdout so the JSON-shaped `dashboard { ... }` lines land on
      // the single pipe the reader scans.
      { stdout: "pipe", stderr: "pipe" },
    );

    const decoder = new TextDecoder();
    const deadline = Date.now() + 30_000;
    let buffer = "";
    let firstProgressLine: string | undefined;

    // Read both stdout AND stderr concurrently — Effect.log writes
    // structured logs to stderr by default in headless mode.
    const readerOut = proc.stdout.getReader();
    const readerErr = proc.stderr.getReader();
    const pump = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
    ): Promise<void> => {
      while (Date.now() < deadline && firstProgressLine === undefined) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const dashIdx = buffer.lastIndexOf("dashboard {");
        if (dashIdx >= 0) {
          const tail = buffer.slice(dashIdx);
          const blocksMatch = /blocks:\s*(\d+)/.exec(tail);
          const tipMatch = /tipSlot:\s*"([^"]+)"/.exec(tail);
          if (
            blocksMatch !== null &&
            tipMatch !== null &&
            Number.parseInt(blocksMatch[1]!, 10) > 0 &&
            tipMatch[1] !== "0"
          ) {
            firstProgressLine = tail.slice(0, 400);
            return;
          }
        }
        if (buffer.length > 64 * 1024) buffer = buffer.slice(-32 * 1024);
      }
    };
    try {
      // Race both readers; whichever finds the dashboard line first
      // wins, the other is cancelled via the shared deadline +
      // firstProgressLine flag inside `pump`.
      await Promise.race([
        pump(readerOut),
        pump(readerErr),
        // Surface early-exit + spawn failures: if the subprocess
        // dies before either pump finds the dashboard line,
        // `proc.exited` resolves and we abort with a diagnostic
        // line so the test failure message is actionable.
        proc.exited.then((code) => {
          if (firstProgressLine === undefined) {
            firstProgressLine = `(subprocess exited early with code ${code}; buffer head: ${buffer.slice(0, 400)})`;
          }
        }),
      ]);
    } finally {
      readerOut.releaseLock();
      readerErr.releaseLock();
      proc.kill();
      await proc.exited;
    }

    expect(
      firstProgressLine?.startsWith("(subprocess exited early") ? undefined : firstProgressLine,
      `expected dashboard tick with blocks > 0 + non-origin tipSlot. saw: ${firstProgressLine ?? "<nothing>"}`,
    ).toBeDefined();
  }, 60_000);
});
