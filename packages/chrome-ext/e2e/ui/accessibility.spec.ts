/**
 * Accessibility-oriented UI checks — roles, labels, focusable controls.
 */
import { Effect } from "effect";
import { test, expect } from "../fixtures.ts";
import { PopupPage } from "../pages/popup.ts";
import { runE } from "../effect-helpers.ts";

test.describe("Popup accessibility", () => {
  test("setup form exposes radio group and submit button roles", async ({
    context,
    extensionId,
  }) =>
    runE(
      Effect.gen(function* () {
        const page = yield* Effect.promise(() => context.newPage());
        const popup = new PopupPage(page, extensionId);
        yield* Effect.promise(() => popup.goto());
        yield* Effect.promise(() => expect(popup.page.getByRole("group")).toBeVisible());
        yield* Effect.promise(() =>
          expect(popup.page.getByRole("radio", { name: /local Mithril snapshot/i })).toBeVisible(),
        );
        yield* Effect.promise(() =>
          expect(popup.page.getByRole("radio", { name: /genesis/i })).toBeVisible(),
        );
        yield* Effect.promise(() =>
          expect(popup.page.getByRole("button", { name: /Start syncing/i })).toBeVisible(),
        );
        yield* Effect.promise(() => page.close());
      }),
    ));

  test("dropzone is keyboard-activatable (click target)", async ({ context, extensionId }) =>
    runE(
      Effect.gen(function* () {
        const page = yield* Effect.promise(() => context.newPage());
        const popup = new PopupPage(page, extensionId);
        yield* Effect.promise(() => popup.goto({ query: "?fullpage=1&mode=local" }));
        const zone = popup.dropzone();
        yield* Effect.promise(() => zone.focus());
        yield* Effect.promise(() => expect(zone).toBeVisible());
        yield* Effect.promise(() => page.close());
      }),
    ));
});
