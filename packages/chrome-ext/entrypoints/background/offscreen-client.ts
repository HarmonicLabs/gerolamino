/**
 * SW-side offscreen lifecycle helpers.
 *
 * `ensureOffscreen` re-checks `getContexts()` on every call and only
 * fires `createDocument` when needed. Singleton-race tolerant.
 */
import { Effect } from "effect";

/** Dev/Playwright builds defer bootstrap via query param — SW boots offscreen
 *  before `addInitScript` can write `chrome.storage.session`. */
const OFFSCREEN_URL = import.meta.env.DEV
  ? "offscreen.html?deferBootstrapSync=1"
  : "offscreen.html";

const offscreenExists = Effect.tryPromise({
  try: () =>
    globalThis.chrome.runtime.getContexts({
      contextTypes: [globalThis.chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    }),
  catch: (e) => e,
}).pipe(
  Effect.map((ctxs) => ctxs.length > 0),
  Effect.orElseSucceed(() => true),
);

const SINGLETON_RACE_MESSAGE = "Only a single offscreen document may be created";

export const ensureOffscreen = Effect.gen(function* () {
  if (yield* offscreenExists) return;

  yield* Effect.tryPromise({
    try: () =>
      globalThis.chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [globalThis.chrome.offscreen.Reason.WORKERS],
        justification: "Run an in-browser Cardano node compute Worker beyond the SW idle limit",
      }),
    catch: (e) => e,
  }).pipe(
    Effect.catch((e) => {
      if (String(e).includes(SINGLETON_RACE_MESSAGE)) {
        return offscreenExists.pipe(
          Effect.flatMap((exists) =>
            exists ? Effect.void : Effect.fail(e),
          ),
        );
      }
      return Effect.fail(e);
    }),
  );
}).pipe(Effect.tap(() => Effect.log("[offscreen-client] Offscreen document ready")));
