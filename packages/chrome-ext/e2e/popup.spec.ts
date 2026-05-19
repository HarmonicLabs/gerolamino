/**
 * Popup UI tests.
 *
 * The popup loads `chrome-extension://<id>/popup.html`, which mounts
 * `<BrowserDashboard>` from `entrypoints/popup/dashboard/index.tsx`.
 *
 * Each test body is an Effect program; the Page lifetime is bound via
 * `withPage` (Effect.acquireUseRelease) so close-on-failure is automatic.
 */
import { Effect } from "effect";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import {
  pageEvaluate,
  pollSync,
  pollUntil,
  runE,
  sleep,
  swLogsMatch,
  waitForLoadState,
  withPage,
} from "./effect-helpers.ts";

const STORAGE_KEY = "gerolamino:bootstrap-settings";
/** Matches the JSON-string envelope produced by `Schema.fromJsonString(BootstrapSettings)`. */
const SEED_JSON = JSON.stringify({ mode: "genesis", serverUrl: "ws://localhost:3040" });

/** Cast-free global declaration for the popup-side port-connect counter
 *  injected via `addInitScript`. */
declare global {
  // eslint-disable-next-line no-var
  var __PORT_CONNECT_COUNT__: number;
}

/**
 * Seed genesis-mode settings into `chrome.storage.local` BEFORE the popup
 * mounts. The popup's resource read decodes them via the same Schema codec
 * and renders `<BrowserDashboard>` (which connects via `chrome.runtime.connect`)
 * instead of the SetupForm.
 */
const seedGenesisSettings = (page: Page): Effect.Effect<void> =>
  Effect.promise(() =>
    page.evaluate(
      ([key, value]) =>
        new Promise<void>((resolve) => {
          globalThis.chrome.storage.local.set({ [key]: value }, () => resolve());
        }),
      [STORAGE_KEY, SEED_JSON] as const,
    ),
  );

test.describe("Popup", () => {
  test("popup.html is reachable + Solid renders into #root", async ({ openPopup }) =>
    runE(
      withPage(openPopup, (popup) =>
        Effect.gen(function* () {
          yield* waitForLoadState(popup);
          const rootHtmlLength = yield* pageEvaluate(
            popup,
            () => document.getElementById("root")?.innerHTML.length ?? 0,
          );
          expect(rootHtmlLength).toBeGreaterThan(100);
        }),
      ),
    ));

  test("dark theme is applied at the document root", async ({ openPopup }) =>
    runE(
      withPage(openPopup, (popup) =>
        Effect.gen(function* () {
          yield* waitForLoadState(popup);
          const hasDarkClass = yield* pageEvaluate(
            popup,
            () => document.querySelectorAll<HTMLElement>(".dark").length > 0,
          );
          expect(hasDarkClass).toBe(true);
        }),
      ),
    ));

  test("Tailwind utilities are wired (background + foreground tokens)", async ({ openPopup }) =>
    runE(
      withPage(openPopup, (popup) =>
        Effect.gen(function* () {
          yield* waitForLoadState(popup);
          const tokens = yield* pageEvaluate(popup, () => ({
            bg: document.querySelectorAll(".bg-background").length,
            fg: document.querySelectorAll(".text-foreground").length,
          }));
          expect(tokens.bg).toBeGreaterThan(0);
          expect(tokens.fg).toBeGreaterThan(0);
        }),
      ),
    ));

  test("popup mounts a non-empty dashboard tree", async ({ openPopup }) =>
    runE(
      // Seed genesis settings in a throwaway popup so the next open routes to
      // the BrowserDashboard (rather than SetupForm).
      Effect.gen(function* () {
        yield* withPage(openPopup, (popup) =>
          Effect.gen(function* () {
            yield* waitForLoadState(popup);
            yield* seedGenesisSettings(popup);
          }),
        );
        yield* withPage(openPopup, (popup) =>
          Effect.gen(function* () {
            yield* waitForLoadState(popup);
            // Tick for Solid to settle on initial atom defaults.
            yield* sleep(300);
            const elementCount = yield* pageEvaluate(
              popup,
              () => document.getElementById("root")?.querySelectorAll("*").length ?? 0,
            );
            // Sanity floor — the Dashboard layout alone produces 30+ DOM nodes.
            expect(elementCount).toBeGreaterThan(20);
          }),
        );
      }),
    ));

  test("popup boots an Effect-runFork that connects via Port", async ({
    context,
    extensionId,
  }) =>
    runE(
      Effect.gen(function* () {
        // Seed genesis settings so the popup routes to BrowserDashboard.
        const seedPopup = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() =>
          seedPopup.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* waitForLoadState(seedPopup);
        yield* Effect.promise(() =>
          seedPopup.evaluate(
            ([key, value]) =>
              new Promise<void>((resolve) => {
                globalThis.chrome.storage.local.set({ [key]: value }, () => resolve());
              }),
            ["gerolamino:bootstrap-settings", SEED_JSON] as const,
          ),
        );
        yield* sleep(200);
        yield* Effect.promise(() => seedPopup.close());

        // Open the dashboard popup with an init-script that wraps
        // `chrome.runtime.connect` to count calls. Asserting on this counter
        // verifies BrowserDashboard's `Effect.runFork` lands AND reaches the
        // Port-opening side-effect — without relying on SW log capture, which
        // is unreliable in Playwright because the SW background.js script
        // doesn't run in the test environment (see
        // `project_sw_script_doesnt_run_in_playwright.md`).
        const popup = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() =>
          popup.addInitScript(() => {
            globalThis.__PORT_CONNECT_COUNT__ = 0;
            const orig = globalThis.chrome.runtime.connect.bind(
              globalThis.chrome.runtime,
            );
            // Object.defineProperty avoids cast-fighting Chrome's overloaded
            // `connect` signature — the wrapper just forwards all args.
            Object.defineProperty(globalThis.chrome.runtime, "connect", {
              configurable: true,
              writable: true,
              value: (...args: Parameters<typeof orig>) => {
                globalThis.__PORT_CONNECT_COUNT__ += 1;
                return orig(...args);
              },
            });
          }),
        );
        yield* Effect.promise(() =>
          popup.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* waitForLoadState(popup);

        yield* pollUntil(
          Effect.gen(function* () {
            const count = yield* Effect.promise(() =>
              popup.evaluate(() => globalThis.__PORT_CONNECT_COUNT__),
            );
            return count > 0;
          }),
          {
            timeoutMs: 15_000,
            description: "popup calls chrome.runtime.connect (Effect.runFork landed)",
          },
        );
        yield* Effect.promise(() => popup.close());
      }),
    ));
});
