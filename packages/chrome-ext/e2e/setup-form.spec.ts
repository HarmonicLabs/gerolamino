/**
 * SetupForm E2E — first-open form picks a bootstrap mode, the choice
 * persists to `chrome.storage.local`, and the popup re-renders into
 * the dashboard.
 *
 * The harness is split across the three modes:
 *
 *   1. **first-open shows the form** — `chrome.storage.local` is empty
 *      on a fresh persistent context, so the popup must render
 *      `<SetupForm>` (data-testid="mode-remote"). No SW interaction
 *      yet — the SW reads the same key on its own startup, but the
 *      popup is the only thing under assertion here.
 *
 *   2. **picking "genesis" persists the choice** — clicking
 *      `data-testid="mode-genesis"` then `data-testid="submit"` writes
 *      `{ mode: "genesis", … }` into the storage key. The popup
 *      re-renders into the dashboard. We re-open the popup and assert
 *      the form is gone.
 *
 *   3. **picking "remote" with a URL persists the URL** — the URL
 *      input is type-checked client-side (must start with `ws://`).
 *      We assert the resulting storage shape so the SW would pick it
 *      up on next start.
 *
 * Reachability of the bootstrap server isn't asserted — that's
 * `bootstrap-localhost.spec.ts`'s job. This spec proves the
 * popup-side wiring and the storage round-trip, in isolation.
 *
 * Test bodies are Effect programs.
 */
import { Effect, Schema } from "effect";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import {
  BootstrapSettings,
  runE,
  sleep,
  waitForLoadState,
  withPage,
} from "./effect-helpers.ts";

const STORAGE_KEY = "gerolamino:bootstrap-settings";

/**
 * Read + structurally-validate the persisted bootstrap settings. The
 * production code now persists via `Schema.fromJsonString(BootstrapSettings)`,
 * so chrome.storage holds the JSON-string form, not the native object form;
 * tests decode through the same codec instead of hand-parsing.
 */
const decodeStoredJson = Schema.decodeUnknownEffect(Schema.fromJsonString(BootstrapSettings));

const readStoredSettings = (page: Page): Effect.Effect<BootstrapSettings | undefined> =>
  Effect.promise(() =>
    page.evaluate(
      (key) =>
        new Promise<unknown>((resolve) => {
          globalThis.chrome.storage.local.get(key, (result) => resolve(result[key]));
        }),
      STORAGE_KEY,
    ),
  ).pipe(
    Effect.flatMap((raw) =>
      typeof raw !== "string"
        ? Effect.succeed<BootstrapSettings | undefined>(undefined)
        : decodeStoredJson(raw).pipe(Effect.orElseSucceed(() => undefined)),
    ),
  );

const clearStoredSettings = (page: Page): Effect.Effect<void> =>
  Effect.promise(() =>
    page.evaluate(
      (key) =>
        new Promise<void>((resolve) => {
          globalThis.chrome.storage.local.remove(key, () => resolve());
        }),
      STORAGE_KEY,
    ),
  );

/**
 * Open the popup, clear `chrome.storage.local`, close, then re-open with the
 * cleared state and run the test body. Two scoped `withPage` calls; no manual
 * `popupRef` + try/finally — Effect.scope handles the lifecycle.
 */
const withFreshlyClearedPopup = (
  openPopup: () => Promise<Page>,
  body: (popup: Page) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* withPage(openPopup, (popup) =>
      Effect.gen(function* () {
        yield* waitForLoadState(popup);
        yield* clearStoredSettings(popup);
      }),
    );
    yield* withPage(openPopup, (popup) =>
      Effect.gen(function* () {
        yield* waitForLoadState(popup);
        yield* body(popup);
      }),
    );
  });

/** Promise-returning thunk for `expect.poll(...)`. */
const pollSettings = (page: Page) => () =>
  readStoredSettings(page).pipe(Effect.runPromise);

test.describe("Popup setup form", () => {
  test("first open renders the form (no persisted settings yet)", async ({ openPopup }) =>
    runE(
      withPage(openPopup, (popup) =>
        Effect.gen(function* () {
          yield* waitForLoadState(popup);
          // Storage starts empty in a fresh persistent context, so the form
          // must mount. Only `local` + `genesis` remain post-apps/bootstrap deletion.
          yield* Effect.promise(() =>
            expect(popup.getByTestId("mode-local")).toBeVisible({ timeout: 10_000 }),
          );
          yield* Effect.promise(() => expect(popup.getByTestId("mode-genesis")).toBeVisible());
          yield* Effect.promise(() => expect(popup.getByTestId("submit")).toBeVisible());
        }),
      ),
    ));

  test("picking genesis persists `{ mode: 'genesis' }` and dismisses the form", async ({
    openPopup,
  }) =>
    runE(
      Effect.gen(function* () {
        yield* withFreshlyClearedPopup(openPopup, (popup) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              expect(popup.getByTestId("mode-genesis")).toBeVisible({ timeout: 10_000 }),
            );
            yield* Effect.promise(() => popup.getByTestId("mode-genesis").click());
            yield* Effect.promise(() => popup.getByTestId("submit").click());

            yield* Effect.promise(() =>
              expect
                .poll(pollSettings(popup), { timeout: 5_000 })
                .toMatchObject({ mode: "genesis" }),
            );
          }),
        );

        // Re-open the popup; the form should NOT mount because the choice
        // is now persisted.
        yield* withPage(openPopup, (popup) =>
          Effect.gen(function* () {
            yield* waitForLoadState(popup);
            // Wait long enough for the loadSettings promise to resolve.
            yield* sleep(500);
            yield* Effect.promise(() => expect(popup.getByTestId("submit")).toHaveCount(0));
          }),
        );
      }),
    ));

  test("local mode shows the snapshot dropzone (drag-drop ingest path)", async ({ openPopup }) =>
    runE(
      withFreshlyClearedPopup(openPopup, (popup) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            expect(popup.getByTestId("mode-local")).toBeVisible({ timeout: 10_000 }),
          );
          yield* Effect.promise(() => popup.getByTestId("mode-local").click());
          yield* Effect.promise(() =>
            expect(popup.getByTestId("snapshot-dropzone")).toBeVisible(),
          );
        }),
      ),
    ));

  test("local mode without upload errors at submit (gate on snapshotUploaded)", async ({
    openPopup,
  }) =>
    runE(
      withFreshlyClearedPopup(openPopup, (popup) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => popup.getByTestId("mode-local").click());
          yield* Effect.promise(() => popup.getByTestId("submit").click());

          yield* Effect.promise(() =>
            expect(popup.getByTestId("error")).toBeVisible({ timeout: 2_000 }),
          );
          yield* Effect.promise(() =>
            expect(popup.getByTestId("error")).toContainText(/Upload a snapshot first/),
          );
          // Storage stays untouched.
          yield* Effect.promise(() =>
            expect.poll(pollSettings(popup), { timeout: 1_000 }).toBeUndefined(),
          );
        }),
      ),
    ));
});
