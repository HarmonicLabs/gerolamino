/**
 * Streaming-RPC tests (state-probe variant).
 *
 * The popup's BrowserDashboard opens a `chrome.runtime.Port` via
 * `chrome.runtime.connect({ name: "rpc" })` and consumes the offscreen's
 * `SubscribeAtomDeltas` stream relayed by the SW. The original assertions
 * polled the SW-side `[rpc-transport] Client N connected` log line; that
 * approach is unreliable in Playwright because the SW background script
 * doesn't actually execute in the test environment (see
 * `project_sw_script_doesnt_run_in_playwright.md`).
 *
 * These tests instead use `addInitScript` to install a wrapper around
 * `chrome.runtime.connect` in the popup context (cast-free via
 * `Object.defineProperty`) that increments `globalThis.__PORT_CONNECT_COUNT__`
 * on every call. Assertions poll the counter via `popup.evaluate`. This
 * directly verifies that the popup-side Effect.runFork lands AND reaches
 * the Port-opening side-effect.
 */
import { Effect } from "effect";
import { test, expect } from "./fixtures.ts";
import {
  pageEvaluate,
  pollSync,
  pollUntil,
  runE,
  sleep,
  waitForLoadState,
  withPage,
} from "./effect-helpers.ts";

const STORAGE_KEY = "gerolamino:bootstrap-settings";
const SEED_JSON = JSON.stringify({ mode: "genesis", serverUrl: "ws://localhost:3040" });

declare global {
  // eslint-disable-next-line no-var
  var __PORT_CONNECT_COUNT__: number;
}

/** Returns an `addInitScript`-installable function that wraps
 *  `chrome.runtime.connect` in the popup context with a Port-call counter.
 *  `Object.defineProperty` dodges Chrome's overloaded signature so no `as`
 *  cast is needed at the assignment site. */
const installPortConnectCounter = () => {
  globalThis.__PORT_CONNECT_COUNT__ = 0;
  const orig = globalThis.chrome.runtime.connect.bind(globalThis.chrome.runtime);
  Object.defineProperty(globalThis.chrome.runtime, "connect", {
    configurable: true,
    writable: true,
    value: (...args: Parameters<typeof orig>) => {
      globalThis.__PORT_CONNECT_COUNT__ += 1;
      return orig(...args);
    },
  });
};

const seedGenesisSettings = (page: import("@playwright/test").Page): Effect.Effect<void> =>
  Effect.promise(() =>
    page.evaluate(
      ([key, value]) =>
        new Promise<void>((resolve) => {
          globalThis.chrome.storage.local.set({ [key]: value }, () => resolve());
        }),
      [STORAGE_KEY, SEED_JSON] as const,
    ),
  );

/** Open the popup with the Port-connect counter pre-installed, after first
 *  seeding chrome.storage.local so the popup mounts BrowserDashboard
 *  (which calls chrome.runtime.connect) rather than SetupForm (which doesn't). */
const openInstrumentedPopup = (context: import("@playwright/test").BrowserContext, extensionId: string) =>
  Effect.gen(function* () {
    const seedPopup = yield* Effect.promise(() => context.newPage());
    yield* Effect.promise(() =>
      seedPopup.goto(`chrome-extension://${extensionId}/popup.html`),
    );
    yield* waitForLoadState(seedPopup);
    yield* seedGenesisSettings(seedPopup);
    yield* sleep(200);
    yield* Effect.promise(() => seedPopup.close());

    const popup = yield* Effect.promise(() => context.newPage());
    yield* Effect.promise(() => popup.addInitScript(installPortConnectCounter));
    yield* Effect.promise(() =>
      popup.goto(`chrome-extension://${extensionId}/popup.html`),
    );
    yield* waitForLoadState(popup);
    return popup;
  });

test.describe("Streaming RPC (BroadcastDeltas)", () => {
  test("popup connect increments the popup-side Port counter", async ({
    context,
    extensionId,
  }) =>
    runE(
      Effect.gen(function* () {
        const popup = yield* openInstrumentedPopup(context, extensionId);
        yield* pollUntil(
          Effect.gen(function* () {
            const count = yield* Effect.promise(() =>
              popup.evaluate(() => globalThis.__PORT_CONNECT_COUNT__),
            );
            return count > 0;
          }),
          { timeoutMs: 15_000, description: "Port counter > 0" },
        );
        yield* Effect.promise(() => popup.close());
      }),
    ));

  test("popup close does not crash the runtime — re-open still connects", async ({
    context,
    extensionId,
  }) =>
    runE(
      Effect.gen(function* () {
        const first = yield* openInstrumentedPopup(context, extensionId);
        yield* pollUntil(
          Effect.gen(function* () {
            const count = yield* Effect.promise(() =>
              first.evaluate(() => globalThis.__PORT_CONNECT_COUNT__),
            );
            return count > 0;
          }),
          { timeoutMs: 15_000, description: "first popup Port counter > 0" },
        );
        yield* Effect.promise(() => first.close());

        // Re-open: fresh popup gets its own counter. A working runtime keeps
        // delivering the Port — broken disconnect / leaked state would
        // surface here as `count` stuck at 0.
        const second = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() => second.addInitScript(installPortConnectCounter));
        yield* Effect.promise(() =>
          second.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* waitForLoadState(second);
        yield* pollUntil(
          Effect.gen(function* () {
            const count = yield* Effect.promise(() =>
              second.evaluate(() => globalThis.__PORT_CONNECT_COUNT__),
            );
            return count > 0;
          }),
          { timeoutMs: 15_000, description: "second popup Port counter > 0" },
        );
        yield* Effect.promise(() => second.close());
      }),
    ));

  test("popup applies the initial-snapshot delta (atoms hydrated)", async ({
    context,
    extensionId,
  }) =>
    runE(
      Effect.gen(function* () {
        // Seed genesis settings so the dashboard branch renders (which is
        // where atom-derived DOM nodes accumulate; SetupForm's body is
        // short).
        const popup = yield* openInstrumentedPopup(context, extensionId);
        yield* pollUntil(
          Effect.gen(function* () {
            const len = yield* Effect.promise(() =>
              popup.evaluate(() => document.body.innerText.length),
            );
            return len > 20;
          }),
          { timeoutMs: 15_000, description: "popup body text grows past 20 chars" },
        );
        yield* Effect.promise(() => popup.close());
      }),
    ));

  test("two concurrent popups each connect their own port", async ({
    context,
    extensionId,
  }) =>
    runE(
      Effect.gen(function* () {
        const seedPopup = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() =>
          seedPopup.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* waitForLoadState(seedPopup);
        yield* seedGenesisSettings(seedPopup);
        yield* sleep(200);
        yield* Effect.promise(() => seedPopup.close());

        const p1 = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() => p1.addInitScript(installPortConnectCounter));
        yield* Effect.promise(() =>
          p1.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* waitForLoadState(p1);

        const p2 = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() => p2.addInitScript(installPortConnectCounter));
        yield* Effect.promise(() =>
          p2.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* waitForLoadState(p2);

        try {
          yield* pollUntil(
            pollSync(() => true).pipe(
              Effect.flatMap(() =>
                Effect.promise(async () => {
                  const c1 = await p1.evaluate(() => globalThis.__PORT_CONNECT_COUNT__);
                  const c2 = await p2.evaluate(() => globalThis.__PORT_CONNECT_COUNT__);
                  return c1 > 0 && c2 > 0;
                }),
              ),
            ),
            { timeoutMs: 15_000, description: "both popups Port-counter > 0" },
          );
        } finally {
          yield* Effect.promise(() => p1.close());
          yield* Effect.promise(() => p2.close());
        }
      }),
    ));
});
