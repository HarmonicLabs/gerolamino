/**
 * SW `onMessage` handler for popup upload — registered at module load so a
 * cold-start `sendMessage` is not lost while `main()` is still booting.
 */
import { Effect, Predicate } from "effect";
import { ensureOffscreen } from "./offscreen-client.ts";
import { ENSURE_OFFSCREEN_MESSAGE_TAG } from "../shared/ensure-offscreen-message.ts";
import { TestLogBufferLayer } from "../shared/test-log-buffer.ts";

const isEnsureOffscreenMessage = (message: unknown): message is { readonly _tag: string } =>
  Predicate.isObject(message) &&
  "_tag" in message &&
  message._tag === ENSURE_OFFSCREEN_MESSAGE_TAG;

const runEnsureOffscreen = (): Promise<{ readonly ok: boolean; readonly error?: string }> =>
  Effect.runPromise(
    ensureOffscreen.pipe(
      Effect.as({ ok: true as const }),
      Effect.catchAll((err) =>
        Effect.succeed({ ok: false as const, error: String(err) }),
      ),
      Effect.provide(TestLogBufferLayer),
    ),
  );

globalThis.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isEnsureOffscreenMessage(message)) return;
  void runEnsureOffscreen().then(sendResponse);
  return true;
});
