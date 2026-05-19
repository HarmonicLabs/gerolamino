/**
 * Test-friendly log buffer for the chrome-ext SW + offscreen.
 *
 * Playwright's `worker.on("console", ...)` only attaches after the
 * `serviceworker` event fires; the SW emits boot logs synchronously inside
 * `main()` *before* the CDP session is wired up, so those messages are
 * silently lost to test assertions. Additionally MV3 SWs restart on idle
 * (~30s), so a `globalThis`-backed buffer evaporates with each restart.
 *
 * This module installs a *secondary* Logger that:
 *   1. Pushes every line into a `globalThis` ring buffer for in-context reads.
 *   2. Mirrors the latest N lines into `chrome.storage.session` (under
 *      `__gerolamino_logs__`) — `session` persists across SW restarts within
 *      the same browser session, so a Playwright `serviceWorker.evaluate(...)`
 *      can always read recent SW + offscreen log lines regardless of when
 *      the CDP session attached.
 *
 * The original console-writing logger is preserved via `mergeWithExisting:
 * true`, so devtools logging is unchanged for human debugging.
 *
 * Note on typing: this module declares a typed `globalThis` extension via
 * a module-level `declare global` so the buffer attachment + read paths
 * are cast-free (`as const` is the only typecast allowed; see
 * `feedback_no_typecasting.md`).
 */
import { Logger } from "effect";

const RING_CAP = 256;
const STORAGE_KEY = "__gerolamino_logs__";

interface LogBuffer {
  readonly push: (line: string) => void;
  readonly snapshot: () => ReadonlyArray<string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __GEROLAMINO_LOG_BUFFER__: LogBuffer | undefined;
}

const getOrCreateBuffer = (): LogBuffer => {
  if (globalThis.__GEROLAMINO_LOG_BUFFER__) return globalThis.__GEROLAMINO_LOG_BUFFER__;
  const ring: Array<string> = [];
  const buf: LogBuffer = {
    push: (line) => {
      ring.push(line);
      if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
      // Mirror to chrome.storage.session if available so cross-restart
      // reads from Playwright still see the most recent N lines. Best-effort —
      // we don't await the promise to avoid serialising every Effect.log call
      // on a chrome IPC round-trip.
      void globalThis.chrome?.storage?.session
        ?.set({ [STORAGE_KEY]: ring.slice() })
        ?.catch(() => undefined);
    },
    snapshot: () => ring.slice(),
  };
  globalThis.__GEROLAMINO_LOG_BUFFER__ = buf;
  return buf;
};

const formatLine = (opts: {
  readonly logLevel: string;
  readonly message: unknown;
  readonly date: Date;
}): string => {
  const msg = Array.isArray(opts.message) ? opts.message.join(" ") : String(opts.message);
  return `[${opts.date.toISOString()}] ${opts.logLevel.toUpperCase()}: ${msg}`;
};

const bufferLogger = Logger.make((opts) => {
  const buf = getOrCreateBuffer();
  const line = formatLine({
    logLevel: opts.logLevel,
    message: opts.message,
    date: opts.date,
  });
  buf.push(line);
  // Mirror to console so devtools still shows boot logs for humans + the
  // Playwright `worker.on("console")` listener picks them up once CDP
  // attaches (best-effort secondary channel).
  // eslint-disable-next-line no-console
  globalThis.console.log(line);
});

/**
 * Drop-in Layer that adds the buffer logger to the existing logger set.
 * `mergeWithExisting: true` keeps the default console logger intact, so the
 * buffer is purely additive — devtools output is unchanged.
 */
export const TestLogBufferLayer = Logger.layer([bufferLogger], { mergeWithExisting: true });

export const TEST_LOG_STORAGE_KEY = STORAGE_KEY;
