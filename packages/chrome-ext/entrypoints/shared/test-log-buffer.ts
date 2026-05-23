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
 *   2. Mirrors each context's ring into `chrome.storage.session` under a
 *      context-specific key (`__gerolamino_logs__:sw|offscreen|popup`).
 *      Blind `set(ring.slice())` from one MV3 context used to clobber the
 *      other's lines; separate keys let Playwright merge on read.
 *   3. Fans each line out on `gerolamino/e2e-test-log` so probe pages can
 *      collect offscreen lines even when session storage mirroring is flaky.
 *
 * The original console-writing logger is preserved via `mergeWithExisting:
 * true`, so devtools logging is unchanged for human debugging.
 */
import { Logger } from "effect";

const RING_CAP = 256;
const STORAGE_PREFIX = "__gerolamino_logs__";
const E2E_LOG_CHANNEL = "gerolamino/e2e-test-log";

/** Legacy single-key name — kept for docs; reads merge all `STORAGE_PREFIX:*` keys. */
export const TEST_LOG_STORAGE_KEY = STORAGE_PREFIX;

interface LogBuffer {
  readonly push: (line: string) => void;
  readonly snapshot: () => ReadonlyArray<string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __GEROLAMINO_LOG_BUFFER__: LogBuffer | undefined;
}

const sessionKeyForContext = (): string => {
  const href = globalThis.location?.href ?? "";
  if (href.includes("offscreen.html")) return `${STORAGE_PREFIX}:offscreen`;
  if (
    typeof ServiceWorkerGlobalScope !== "undefined" &&
    globalThis instanceof ServiceWorkerGlobalScope
  ) {
    return `${STORAGE_PREFIX}:sw`;
  }
  return `${STORAGE_PREFIX}:popup`;
};

const mirrorRingToSession = (ring: ReadonlyArray<string>, key: string): void => {
  void globalThis.chrome?.storage?.session
    ?.set({ [key]: ring.slice() })
    ?.catch(() => undefined);
};

const fanOutTestLogLine = (line: string): void => {
  try {
    new BroadcastChannel(E2E_LOG_CHANNEL).postMessage(line);
  } catch {
    // BC unavailable in this context.
  }
};

const getOrCreateBuffer = (): LogBuffer => {
  if (globalThis.__GEROLAMINO_LOG_BUFFER__) return globalThis.__GEROLAMINO_LOG_BUFFER__;
  const sessionKey = sessionKeyForContext();
  const ring: Array<string> = [];
  const buf: LogBuffer = {
    push: (line) => {
      ring.push(line);
      if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
      mirrorRingToSession(ring, sessionKey);
      fanOutTestLogLine(line);
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
  // eslint-disable-next-line no-console
  globalThis.console.log(line);
});

export const TestLogBufferLayer = Logger.layer([bufferLogger], { mergeWithExisting: true });

/** Best-effort mirror for forked fibers that may not inherit `TestLogBufferLayer`. */
export const appendSessionLogLine = (line: string): void => {
  getOrCreateBuffer().push(line);
};

/** Merge all context-specific session rings (for Playwright `page.evaluate`). */
export const readMergedSessionLogLines = async (): Promise<Array<string>> => {
  const session = globalThis.chrome?.storage?.session;
  if (session === undefined) return [];
  const bag = await session.get(null);
  const merged: Array<string> = [];
  for (const [key, value] of Object.entries(bag)) {
    if (!key.startsWith(STORAGE_PREFIX) || !Array.isArray(value)) continue;
    merged.push(...value);
  }
  return merged;
};
