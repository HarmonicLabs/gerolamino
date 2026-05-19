/**
 * Effect v4 helpers for Playwright tests.
 *
 * Playwright's runner is promise-based; these helpers bridge each test
 * body to an Effect program so the test logic can use Effect's
 * composition, scoping, scheduling, and Console primitives instead of
 * imperative try/finally + expect.poll boilerplate.
 *
 * Each test body is wrapped in `runE(Effect.gen(function* () { ... }))`,
 * with Page lifetimes scoped via `withPage` and polling assertions via
 * `pollUntil`.
 */
import { Cause, Console, Effect, Schedule, Schema } from "effect";
import type { Page, Worker } from "@playwright/test";
import { takeRight } from "es-toolkit";

/** Run an Effect program; bridge into Playwright's promise-based test. */
export const runE = <A>(eff: Effect.Effect<A>): Promise<A> => Effect.runPromise(eff);

/**
 * Poll an Effect-bound predicate until it returns true, failing with
 * `TimeoutException` if the deadline elapses. Replacement for
 * `expect.poll(fn, { timeout }).toBe(true)` that participates in
 * Effect's scope / interruption / logging.
 */
export const pollUntil = <E>(
  check: Effect.Effect<boolean, E>,
  options: { timeoutMs: number; intervalMs?: number; description?: string },
): Effect.Effect<void, E> => {
  const repeated = check.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(`${options.intervalMs ?? 100} millis`),
      until: (held: boolean) => held,
    }),
  );
  // `timeoutOrElse` keeps the error channel as `E` (no widening to
  // `E | TimeoutException`) by mapping the timeout case into a die. That
  // avoids the cast we'd otherwise need to keep the public return type.
  return repeated.pipe(
    Effect.timeoutOrElse({
      duration: `${options.timeoutMs} millis`,
      orElse: () =>
        Effect.die(
          `[pollUntil] ${options.description ?? "predicate did not hold"} (${options.timeoutMs} ms)`,
        ),
    }),
    Effect.tapCause((cause) =>
      Console.error(
        `[pollUntil] ${options.description ?? "predicate did not hold"} — ${Cause.pretty(cause)}`,
      ),
    ),
    Effect.asVoid,
  );
};

/** Lift a synchronous predicate over an array into an Effect for pollUntil. */
export const pollSync = (predicate: () => boolean): Effect.Effect<boolean> =>
  Effect.sync(predicate);

/**
 * Acquire a Page, run the body, and release the Page even on failure.
 * Direct replacement for `try { await openPopup(); ... } finally { await
 * popup.close(); }`.
 */
export const withPage = <A, E>(
  open: () => Promise<Page>,
  body: (page: Page) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(open),
    body,
    (page) => Effect.promise(() => page.close()),
  );

/**
 * Run a no-arg function inside the page (browser context). For evaluations
 * that need an argument, call `Effect.promise(() => page.evaluate(fn, arg))`
 * directly — wrapping Playwright's two-arg overload erodes its type inference
 * (`Unboxed<T>` mapping fights the helper's generic `T`).
 */
export const pageEvaluate = <A>(
  page: Page,
  fn: () => A | Promise<A>,
): Effect.Effect<A> => Effect.promise(() => page.evaluate(fn));

/** Run a no-arg function inside a Worker (service worker). */
export const workerEvaluate = <A>(
  worker: Worker,
  fn: () => A | Promise<A>,
): Effect.Effect<A> => Effect.promise(() => worker.evaluate(fn));

/** Effect-native `await page.waitForLoadState("domcontentloaded")`. */
export const waitForLoadState = (
  page: Page,
  state: "load" | "domcontentloaded" | "networkidle" = "domcontentloaded",
): Effect.Effect<void> => Effect.promise(() => page.waitForLoadState(state));

/** Effect-native sleep (replaces `await page.waitForTimeout(ms)`). */
export const sleep = (ms: number): Effect.Effect<void> => Effect.sleep(`${ms} millis`);

/** Schema for the SW-captured console-log entry shape. */
export const SwLog = Schema.Struct({
  type: Schema.String,
  text: Schema.String,
  ts: Schema.Number,
});
export type SwLog = typeof SwLog.Type;

/**
 * Read the SW-side log buffer mirrored into `chrome.storage.session` by
 * `TestLogBufferLayer`. Bypasses Playwright's `worker.on("console", ...)`
 * listener — that misses SW boot logs because the CDP session attaches
 * after the first synchronous logger calls. `chrome.storage.session`
 * persists across MV3 SW idle-restarts, so this works even if the SW
 * was torn down between log emission and test read.
 */
const LOG_STORAGE_KEY = "__gerolamino_logs__";

/**
 * Schema for the log buffer payload. Decoding the storage result through
 * this schema gives a typed `ReadonlyArray<string>` without `as` casts;
 * an unexpected shape collapses to an empty array.
 */
const LogLines = Schema.Array(Schema.String);
const decodeLogLines = Schema.decodeUnknownEffect(LogLines);

export const readSwLogBuffer = (worker: Worker): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(() =>
    worker.evaluate(
      async (key) => globalThis.chrome.storage.session.get(key).then((r) => r[key]),
      LOG_STORAGE_KEY,
    ),
  ).pipe(Effect.flatMap((raw) => decodeLogLines(raw).pipe(Effect.orElseSucceed(() => []))));

/** Whether the SW log buffer contains a line matching a substring or regex. */
export const swBufferMatches = (
  logs: ReadonlyArray<string>,
  needle: string | RegExp,
): boolean =>
  typeof needle === "string"
    ? logs.some((l) => l.includes(needle))
    : logs.some((l) => needle.test(l));

/**
 * Schema for the popup-side persisted bootstrap settings. The popup writes
 * one of three modes into `chrome.storage.local`; tests assert the round-trip
 * shape via this schema. Replaces ad-hoc `as` casts on
 * `await page.evaluate(...)` return values.
 */
export const BootstrapSettings = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("genesis") }),
  Schema.Struct({ mode: Schema.Literal("local") }),
  Schema.Struct({
    mode: Schema.Literal("remote"),
    serverUrl: Schema.String,
  }),
]);
export type BootstrapSettings = typeof BootstrapSettings.Type;

/**
 * Schema for the SW capability probe in `service-worker.spec.ts`. Decoding
 * the probe through this schema gives `Schema.is`-style narrowing for the
 * boolean flags + a hard-stop if a future Chrome version flips the shape.
 */
export const SwCapabilityProbe = Schema.Struct({
  hasOPFS: Schema.Boolean,
  hasIndexedDB: Schema.Boolean,
  hasMessageChannel: Schema.Boolean,
  hasWorker: Schema.Boolean,
  syncHandleOk: Schema.Boolean,
  writableOk: Schema.Boolean,
});
export type SwCapabilityProbe = typeof SwCapabilityProbe.Type;

/**
 * Schema for the OPFS-write-back probe in `diag-validate.spec.ts`. The browser
 * function returns either `{ ok: true, log }` or `{ ok: false, log }` plus
 * (when `ok === false`) an error message in the trailing log entry. Decoded
 * value is structurally narrowed, no `as` casts on the bridge return.
 */
export const OpfsRoundTripResult = Schema.Struct({
  ok: Schema.Boolean,
  log: Schema.Array(Schema.String),
});
export type OpfsRoundTripResult = typeof OpfsRoundTripResult.Type;

/**
 * Schema-driven decode wrapper for `page.evaluate` return values. Catches
 * the typical `unknown`-typed bridge return and narrows it via the supplied
 * Schema. Use for any cross-context payload that needs structural validation.
 */
export const decodeFromPage = <S extends Schema.Top>(
  schema: S,
  effect: Effect.Effect<unknown>,
): Effect.Effect<S["Type"], never, S["DecodingServices"]> =>
  effect.pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie),
    ),
  );

const matchesNeedle = (text: string, needle: string | RegExp): boolean =>
  typeof needle === "string" ? text.includes(needle) : needle.test(text);

/** Whether any SW log line matches a substring or regex. */
export const swLogsMatch = (
  logs: ReadonlyArray<SwLog>,
  needle: string | RegExp,
): boolean => logs.some((l) => matchesNeedle(l.text, needle));

/** Count of SW log lines matching a substring or regex. */
export const swLogsCount = (
  logs: ReadonlyArray<SwLog>,
  needle: string | RegExp,
): number => logs.filter((l) => matchesNeedle(l.text, needle)).length;

/**
 * Effectfully dump the most recent N log lines via `Console.log` — replaces
 * the `for (const l of logs.slice(-30)) console.log(l)` pattern in the
 * long-running specs. Uses es-toolkit's `takeRight` (not `Array.slice(-N)`)
 * for an immutable tail; supports both `SwLog` shape and plain strings.
 */
export const dumpRecent = (
  prefix: string,
  logs: ReadonlyArray<string | SwLog>,
  count: number = 30,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Console.log(prefix);
    for (const line of takeRight(logs, count)) {
      const text = typeof line === "string" ? line : line.text;
      yield* Console.log(`  ${text}`);
    }
  });
