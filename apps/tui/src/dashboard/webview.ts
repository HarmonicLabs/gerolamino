/**
 * webview.ts — Bun.WebView lifecycle for the TUI's default render path.
 *
 * Two pieces:
 *   1. `acquireWebView` — `Effect.acquireRelease`-ready resource that
 *      constructs `Bun.WebView`, navigates to the bundled SPA file URL,
 *      and resolves once the page's `load` event fires (so subsequent
 *      `evaluate()` calls are guaranteed to find `window.__APPLY_DELTAS__`).
 *   2. `deltaPushFiber` — a never-returning Effect that builds the JSON
 *      delta from the registry every `DELTA_PUSH_INTERVAL_MS` ms and
 *      pushes it via `view.evaluate("window.__APPLY_DELTAS__(...)")`.
 *      Skips the evaluate when the JSON is unchanged so a steady-state
 *      node doesn't burn IPC cycles.
 *
 * `view.evaluate` is **single-in-flight per view** (per Bun source —
 * `JSWebViewPrototype.cpp:242` throws `ERR_INVALID_STATE` on concurrent
 * calls). The fiber here is the only producer, and `Effect.tryPromise`
 * awaits each call to settle before the next iteration begins, so the
 * constraint is satisfied without an explicit lock.
 *
 * Subprocess-death supervision: `view.evaluate` rejects with an error
 * matching `/closed|died|signal|killed/i` when the Chrome / WebKit
 * subprocess dies. We tag those as `WebViewClosedError` and escalate
 * via `Effect.die` so the parent `Effect.scoped` tears down cleanly
 * instead of silently retrying every tick on a dead view.
 */
import { Effect, Ref, Schedule, Schema, type Scope } from "effect";
import { buildDeltaJson } from "dashboard";
import { registry } from "./atoms.ts";
import {
  WEBVIEW_DEFAULT_WIDTH,
  WEBVIEW_DEFAULT_HEIGHT,
  DELTA_PUSH_INTERVAL_MS,
} from "../constants.ts";

/** Subprocess-death failure — the WebView host (Chrome on Linux,
 *  WebKit on macOS) crashed or closed mid-session. Fatal: surfaces
 *  via `Effect.die` so the program scope tears down cleanly. */
export class WebViewClosedError extends Schema.TaggedErrorClass<WebViewClosedError>()(
  "WebViewClosedError",
  { message: Schema.String },
) {}

/** Transient `evaluate()` failure — page-side exception or IPC hiccup
 *  that doesn't indicate the subprocess is dead. Logged + retried on
 *  the next tick. */
export class WebViewEvalError extends Schema.TaggedErrorClass<WebViewEvalError>()(
  "WebViewEvalError",
  { message: Schema.String },
) {}

const SUBPROCESS_DIED = /closed|died|signal|killed/i;

const classifyEvalError = (e: unknown): WebViewClosedError | WebViewEvalError => {
  const message = e instanceof Error ? e.message : String(e);
  return SUBPROCESS_DIED.test(message)
    ? new WebViewClosedError({ message })
    : new WebViewEvalError({ message });
};

/**
 * Construct + navigate + return the live webview. The `acquireRelease`
 * wrapper guarantees `view.close()` runs on scope exit even if the
 * consensus stack throws mid-sync.
 */
export const acquireWebView = (
  htmlPath: string,
  options?: { width?: number; height?: number },
): Effect.Effect<Bun.WebView, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        if (typeof Bun.WebView !== "function") {
          throw new Error(
            "Bun.WebView is not available — upgrade Bun (>= the WebView-shipping release) or run with --headless.",
          );
        }
        const view = new Bun.WebView({
          width: options?.width ?? WEBVIEW_DEFAULT_WIDTH,
          height: options?.height ?? WEBVIEW_DEFAULT_HEIGHT,
          backend: {
            type: "chrome",
            // Chrome's default headless flags treat each `file://`
            // path as an opaque unique origin, which silently blocks
            // `<script type="module" src="./page.js">` and
            // `<link rel="stylesheet" href="./styles.css">` from the
            // same directory. The HTML still parses, so the host's
            // `view.navigate()` Promise resolves on `Page.loadEventFired`
            // — but the SPA's module script never fetches, so
            // `window.__APPLY_DELTAS__` never registers and every
            // subsequent delta push throws "is not a function". The
            // narrowest unblock is `--allow-file-access-from-files`,
            // which permits same-origin reads under file://. We don't
            // load remote URLs into this webview so loosening the
            // restriction is safe; the alternative (`--disable-web-security`)
            // is the nuclear option and not needed.
            argv: ["--allow-file-access-from-files"],
          },
        });
        await view.navigate(`file://${htmlPath}`);
        return view;
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }),
    (view) => Effect.sync(() => view.close()),
  );

/**
 * Forever-fiber that pushes registry deltas into the webview.
 *
 * The cadence (`DELTA_PUSH_INTERVAL_MS`) targets 60Hz; uPlot, Tailwind,
 * and Solid all rerender well under that frame budget on the panels we
 * ship. Lower would waste IPC; higher would introduce visible lag
 * during catch-up bursts when many `chainEventLogAtom` appends arrive
 * close together.
 *
 * Returns `Effect<void, never>` because the failure modes are handled
 * inline:
 *   - Subprocess death → `Effect.die` tears down the parent scope
 *   - Transient eval failure → log + continue
 */
export const deltaPushFiber = (view: Bun.WebView): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const lastJsonRef = yield* Ref.make("");
    yield* Effect.repeat(
      Effect.gen(function* () {
        const json = buildDeltaJson(registry);
        const last = yield* Ref.get(lastJsonRef);
        if (json === last) return;
        yield* Ref.set(lastJsonRef, json);
        // Embed the JSON as a quoted string inside the JS expression so
        // the page-side `__APPLY_DELTAS__` receives a regular string and
        // calls `JSON.parse(..., reviver)` itself.
        const escaped = JSON.stringify(json);
        yield* Effect.tryPromise({
          try: () => view.evaluate(`window.__APPLY_DELTAS__(${escaped})`),
          catch: classifyEvalError,
        });
      }).pipe(
        Effect.catchTag("WebViewEvalError", (e) =>
          Effect.logWarning(`webview push failed: ${e.message}`),
        ),
        Effect.catchTag("WebViewClosedError", (e) =>
          Effect.die(new Error(`WebView subprocess died: ${e.message}`)),
        ),
      ),
      Schedule.fixed(`${DELTA_PUSH_INTERVAL_MS} millis`),
    );
  });
