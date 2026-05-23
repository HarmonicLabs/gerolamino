/**
 * Ask the service worker to create the offscreen document before popup →
 * offscreen BroadcastChannel upload RPC (popup cannot call `createDocument`).
 */
export const ENSURE_OFFSCREEN_MESSAGE_TAG = "gerolamino/ensure-offscreen" as const;

export type EnsureOffscreenMessage = { readonly _tag: typeof ENSURE_OFFSCREEN_MESSAGE_TAG };

export type EnsureOffscreenResponse = {
  readonly ok: boolean;
  readonly error?: string;
};

export const ensureOffscreenMessage = (): EnsureOffscreenMessage => ({
  _tag: ENSURE_OFFSCREEN_MESSAGE_TAG,
});

const OFFSCREEN_CONTEXT_TYPE = globalThis.chrome.runtime.ContextType.OFFSCREEN_DOCUMENT;

/** True when the WORKERS offscreen document is already running. */
export const offscreenDocumentExists = (): Promise<boolean> => {
  const getContexts = globalThis.chrome.runtime.getContexts;
  if (typeof getContexts !== "function") {
    return Promise.resolve(false);
  }
  return getContexts({ contextTypes: [OFFSCREEN_CONTEXT_TYPE] })
    .then((contexts) => contexts.length > 0)
    .catch(() => false);
};

const sendEnsureOffscreenOnce = (): Promise<void> =>
  new Promise((resolve, reject) => {
    globalThis.chrome.runtime.sendMessage(
      ensureOffscreenMessage(),
      (response: EnsureOffscreenResponse | undefined) => {
        const err = globalThis.chrome.runtime.lastError;
        if (err !== undefined) {
          reject(new Error(err.message));
          return;
        }
        if (response?.ok === true) {
          resolve();
          return;
        }
        reject(new Error(response?.error ?? "ensure offscreen: service worker did not confirm"));
      },
    );
  });

const isRetriableEnsureError = (message: string): boolean =>
  message.includes("message port closed") ||
  message.includes("Receiving end does not exist") ||
  message.includes("Could not establish connection");

/**
 * Ensure the offscreen daemon exists before popup → offscreen BC upload.
 * Retries tolerate MV3 SW cold start (listener registered at module load,
 * but `createDocument` may finish after the first `sendMessage` attempt).
 */
export const requestEnsureOffscreen = async (): Promise<void> => {
  if (await offscreenDocumentExists()) return;

  const deadline = Date.now() + 120_000;
  let attempt = 0;

  while (Date.now() < deadline) {
    if (await offscreenDocumentExists()) return;
    try {
      await sendEnsureOffscreenOnce();
      return;
    } catch (err) {
      if (await offscreenDocumentExists()) return;
      const message = err instanceof Error ? err.message : String(err);
      if (!isRetriableEnsureError(message)) {
        throw err;
      }
      attempt++;
      await new Promise((resolve) => globalThis.setTimeout(resolve, Math.min(250 + attempt * 150, 2_000)));
    }
  }

  if (await offscreenDocumentExists()) return;
  throw new Error("offscreen document not available — reload the extension and retry");
};
