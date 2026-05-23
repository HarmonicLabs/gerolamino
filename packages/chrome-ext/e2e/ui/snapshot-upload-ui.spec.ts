/**
 * Snapshot upload UI — dropzone, open-in-tab affordance, mode switching.
 */
import { Effect } from "effect";
import { test, expect } from "../fixtures.ts";
import { PopupPage } from "../pages/popup.ts";
import { runE } from "../effect-helpers.ts";

const STORAGE_KEY = "gerolamino:bootstrap-settings";

/** `chrome.*` is only available on extension-origin pages — navigate first. */
const withFreshPopup = (
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
  body: (popup: PopupPage) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const page = yield* Effect.promise(() => context.newPage());
    const popup = new PopupPage(page, extensionId);
    try {
      yield* Effect.promise(() => popup.goto());
      yield* Effect.promise(() =>
        page.evaluate((key) => {
          return new Promise<void>((resolve) => {
            globalThis.chrome.storage.local.remove(key, () => resolve());
          });
        }, STORAGE_KEY),
      );
      yield* Effect.promise(() => page.reload());
      yield* Effect.promise(() => page.waitForLoadState("domcontentloaded"));
      yield* body(popup);
    } finally {
      yield* Effect.promise(() => page.close());
    }
  });

test.describe("Snapshot upload UI", () => {
  test("local mode shows dashed dropzone with helper copy", async ({ context, extensionId }) =>
    runE(
      withFreshPopup(context, extensionId, (popup) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => popup.goto());
          yield* Effect.promise(() => popup.modeLocal().click());
          const zone = popup.dropzone();
          yield* Effect.promise(() => expect(zone).toBeVisible());
          yield* Effect.promise(() => expect(zone).toContainText(/Drop a Mithril snapshot/i));
          yield* Effect.promise(() => expect(zone).toContainText(/click to pick/i));
        }),
      ),
    ));

  test("switching genesis hides dropzone", async ({ context, extensionId }) =>
    runE(
      withFreshPopup(context, extensionId, (popup) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => popup.goto());
          yield* Effect.promise(() => popup.modeLocal().click());
          yield* Effect.promise(() => expect(popup.dropzone()).toBeVisible());
          yield* Effect.promise(() => popup.modeGenesis().click());
          yield* Effect.promise(() => expect(popup.dropzone()).toHaveCount(0));
        }),
      ),
    ));

  test("popup-sized viewport shows open-in-tab affordance", async ({ context, extensionId }) =>
    runE(
      withFreshPopup(context, extensionId, (popup) =>
        Effect.gen(function* () {
          // `isInPopupContext()` reads `innerHeight` at mount — set size before reload.
          yield* Effect.promise(() =>
            popup.page.setViewportSize({ width: 380, height: 520 }),
          );
          yield* Effect.promise(() => popup.page.reload());
          yield* Effect.promise(() => popup.page.waitForLoadState("domcontentloaded"));
          yield* Effect.promise(() => popup.modeLocal().click());
          yield* Effect.promise(() => expect(popup.openInTab()).toBeVisible());
        }),
      ),
    ));
});
