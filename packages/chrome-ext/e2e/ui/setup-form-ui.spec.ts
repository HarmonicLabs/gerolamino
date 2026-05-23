/**
 * Setup form UI — Playwright interaction tests (headed `ui` project).
 */
import { Effect } from "effect";
import { test, expect } from "../fixtures.ts";
import { PopupPage } from "../pages/popup.ts";
import { runE } from "../effect-helpers.ts";

const withPopupPage = (
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
  body: (popup: PopupPage) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const page = yield* Effect.promise(() => context.newPage());
    const popup = new PopupPage(page, extensionId);
    try {
      yield* body(popup);
    } finally {
      yield* Effect.promise(() => page.close());
    }
  });

test.describe("Setup form UI", () => {
  test("heading, legend, and mode radios are visible", async ({ context, extensionId }) =>
    runE(
      withPopupPage(context, extensionId, (popup) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => popup.goto());
          yield* Effect.promise(() =>
            expect(popup.heading()).toBeVisible({ timeout: 10_000 }),
          );
          yield* Effect.promise(() => expect(popup.page.getByText("Bootstrap mode")).toBeVisible());
          yield* Effect.promise(() => expect(popup.modeLocal()).toBeVisible());
          yield* Effect.promise(() => expect(popup.modeGenesis()).toBeVisible());
        }),
      ),
    ));

  test("keyboard: Tab moves focus from genesis radio toward submit", async ({
    context,
    extensionId,
  }) =>
    runE(
      withPopupPage(context, extensionId, (popup) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => popup.goto());
          yield* Effect.promise(() => popup.modeGenesis().focus());
          yield* Effect.promise(() => popup.page.keyboard.press("Tab"));
          yield* Effect.promise(() => expect(popup.submit()).toBeFocused());
        }),
      ),
    ));

  test("fullpage URL pre-selects local mode and shows dropzone", async ({ context, extensionId }) =>
    runE(
      withPopupPage(context, extensionId, (popup) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => popup.goto({ query: "?fullpage=1&mode=local" }));
          yield* Effect.promise(() => expect(popup.modeLocal()).toBeChecked());
          yield* Effect.promise(() => expect(popup.dropzone()).toBeVisible());
        }),
      ),
    ));
});
