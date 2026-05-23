/**
 * Dashboard shell UI — reset flow, layout tokens, popup viewport.
 */
import { Effect } from "effect";
import { test, expect } from "../fixtures.ts";
import { PopupPage } from "../pages/popup.ts";
import { runE, sleep } from "../effect-helpers.ts";

const STORAGE_KEY = "gerolamino:bootstrap-settings";
const SEED_JSON = JSON.stringify({ mode: "genesis", serverUrl: "ws://localhost:3040" });

const seedGenesis = (page: import("@playwright/test").Page): Effect.Effect<void> =>
  Effect.promise(() =>
    page.evaluate(
      ([key, value]) =>
        new Promise<void>((resolve) => {
          globalThis.chrome.storage.local.set({ [key]: value }, () => resolve());
        }),
      [STORAGE_KEY, SEED_JSON] as const,
    ),
  );

test.describe("Popup dashboard UI", () => {
  test("seeded genesis settings show reset control and dashboard chrome", async ({
    context,
    extensionId,
  }) =>
    runE(
      Effect.gen(function* () {
        const page = yield* Effect.promise(() => context.newPage());
        const popup = new PopupPage(page, extensionId);
        yield* Effect.promise(() => popup.goto());
        yield* seedGenesis(page);
        yield* Effect.promise(() => page.reload());
        yield* Effect.promise(() => popup.page.waitForLoadState("domcontentloaded"));
        yield* sleep(500);
        yield* Effect.promise(() => expect(popup.resetSettings()).toBeVisible());
        yield* Effect.promise(() =>
          expect(popup.page.locator(".bg-background").first()).toBeVisible(),
        );
        yield* Effect.promise(() => page.close());
      }),
    ));

  test("reset returns to setup form with mode radios", async ({ context, extensionId }) =>
    runE(
      Effect.gen(function* () {
        const page = yield* Effect.promise(() => context.newPage());
        const popup = new PopupPage(page, extensionId);
        yield* Effect.promise(() => popup.goto());
        yield* seedGenesis(page);
        yield* Effect.promise(() => page.reload());
        yield* Effect.promise(() => popup.page.waitForLoadState("domcontentloaded"));
        yield* sleep(400);
        yield* Effect.promise(() => popup.resetSettings().click());
        yield* sleep(500);
        yield* Effect.promise(() => expect(popup.modeGenesis()).toBeVisible());
        yield* Effect.promise(() => expect(popup.submit()).toBeVisible());
        yield* Effect.promise(() => page.close());
      }),
    ));

  test("popup viewport matches extension layout width", async ({ context, extensionId }) =>
    runE(
      Effect.gen(function* () {
        const page = yield* Effect.promise(() => context.newPage());
        const popup = new PopupPage(page, extensionId);
        yield* Effect.promise(() => popup.goto());
        const box = yield* Effect.promise(() =>
          popup.page.locator(".w-\\[380px\\]").first().boundingBox(),
        );
        expect(box).not.toBeNull();
        if (box !== null) {
          expect(box.width).toBeGreaterThan(360);
          expect(box.width).toBeLessThan(400);
        }
        yield* Effect.promise(() => page.close());
      }),
    ));
});
