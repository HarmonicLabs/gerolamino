/**
 * SW-side offscreen lifecycle helpers.
 *
 * Phase D Step 7: the previous module-level `ensurePromise` latch
 * memoised the first-creation outcome, which left the watchdog
 * blind to mid-SW-lifetime offscreen death (Chromium memory-pressure
 * evictions). Wave 20 replaces the latch with a stateless recheck on
 * every call: `getContexts()` runs first, and `createDocument` only
 * fires when the offscreen is genuinely missing. The "single document
 * per extension" race ("Only a single offscreen document may be
 * created") is handled by re-checking after the failure — if it now
 * exists we count the call as successful.
 *
 * `getContexts()` is sub-millisecond on Chromium so the per-call
 * cost is negligible (no real keepalive concern). The previous latch
 * existed to avoid hammering `createDocument` on rapid concurrent
 * calls; without the latch, two simultaneous callers might both pass
 * the existence check and both invoke `createDocument`, losing one to
 * the "single document" race — but the post-failure recheck catches
 * the loser cleanly.
 */
import { Effect } from "effect";
import { pingOffscreen } from "./offscreen-rpc-client.ts";

/** WXT builds `entrypoints/offscreen/index.html` as `/offscreen.html`. */
const OFFSCREEN_URL = "offscreen.html";

const offscreenExists = Effect.tryPromise({
  try: () =>
    globalThis.chrome.runtime.getContexts({
      contextTypes: [globalThis.chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    }),
  catch: (e) => e,
}).pipe(
  Effect.map((ctxs) => ctxs.length > 0),
  // `getContexts` should never reject in a healthy Chrome 116+ environment;
  // if it does (extension permission stripped, etc.), treat as "exists" so
  // we don't spam `createDocument` calls. The downstream RPC will surface
  // the failure when it can't reach the offscreen.
  Effect.orElseSucceed(() => true),
);

const SINGLETON_RACE_MESSAGE = "Only a single offscreen document may be created";

/**
 * Stateless `ensureOffscreen` — recheck on every call. Idempotent:
 * fast no-op when the offscreen already exists; creates one when it
 * doesn't; recovers from the "single document" race by rechecking
 * after a failed `createDocument`.
 */
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
      // Concurrent caller won the create race. Re-check; if it now
      // exists we treat this call as successful (the offscreen IS up,
      // just not by us).
      if (String(e).includes(SINGLETON_RACE_MESSAGE)) {
        return offscreenExists.pipe(
          Effect.flatMap((exists) =>
            exists
              ? Effect.logDebug(
                  "[offscreen-client] createDocument lost the singleton race; offscreen now exists",
                )
              : Effect.fail(e),
          ),
        );
      }
      return Effect.fail(e);
    }),
  );
}).pipe(
  Effect.tap(() => Effect.log("[offscreen-client] Offscreen document ready")),
  // Phase D Step 1 health probe: round-trip a Ping over the new
  // BroadcastChannel RPC plane on every successful ensure-call.
  // Fire-and-forget — `pingOffscreen` already wraps its failures via
  // `Effect.catch` so a broken RPC plane only logs a warning.
  Effect.tap(() => Effect.forkDetach(pingOffscreen)),
);
