/**
 * `KeyValueStore` layer backed by `chrome.storage.local`.
 *
 * The browser's `localStorage` (which Effect's `BrowserKeyValueStore.layerLocalStorage`
 * targets) is not usable from a MV3 service worker — service workers have no
 * `window`, no synchronous DOM Storage. The canonical MV3 cross-context store
 * is `chrome.storage.local`, which:
 *   - Is reachable from SW, offscreen documents, popups, and content scripts.
 *   - Survives SW evictions + popup closes.
 *   - Stores arbitrary JSON-cloneable values (objects, not just strings).
 *
 * This layer wraps it as an Effect `KeyValueStore` so the rest of the codebase
 * can compose against the standard service interface. Strings + `Uint8Array`
 * are encoded transparently: strings round-trip raw; `Uint8Array` round-trips
 * via a `{ __kvBytes: number[] }` envelope so chrome.storage's structured-clone
 * serializer doesn't trip on `Uint8Array` identity.
 */
import { Effect, Layer } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";

interface BytesEnvelope {
  readonly __kvBytes: ReadonlyArray<number>;
}

const isBytesEnvelope = (v: unknown): v is BytesEnvelope => {
  if (typeof v !== "object" || v === null || !("__kvBytes" in v)) return false;
  // After the `in` narrowing TypeScript treats `v.__kvBytes` as `unknown`
  // (broadened from `object`), so we can read it directly without a cast.
  return Array.isArray(v.__kvBytes);
};

const wrapError = (method: string, message: string, cause: unknown) =>
  new KeyValueStore.KeyValueStoreError({ method, message, cause });

const promisify = <A>(
  method: string,
  message: string,
  thunk: () => Promise<A>,
): Effect.Effect<A, KeyValueStore.KeyValueStoreError> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => wrapError(method, message, cause) });

/**
 * Layer that exposes `chrome.storage.local` as the Effect `KeyValueStore`
 * service. Use at the chrome-ext entrypoints (popup App.tsx, offscreen main,
 * service-worker index) to make the global `KeyValueStore.KeyValueStore`
 * service resolvable.
 */
export const ChromeLocalKeyValueStoreLayer: Layer.Layer<KeyValueStore.KeyValueStore> =
  Layer.succeed(
    KeyValueStore.KeyValueStore,
    KeyValueStore.make({
      get: (key) =>
        promisify("get", "chrome.storage.local.get failed", () =>
          globalThis.chrome.storage.local.get(key),
        ).pipe(
          Effect.map((stored: { [k: string]: unknown }) => {
            const raw = stored[key];
            if (raw === undefined) return undefined;
            if (typeof raw === "string") return raw;
            // Object payloads round-trip as JSON strings so the
            // KeyValueStore contract (string-shaped values) is honoured.
            // Callers needing structured shapes encode/decode via Schema
            // on top of this string boundary.
            if (isBytesEnvelope(raw)) return undefined;
            return JSON.stringify(raw);
          }),
        ),
      getUint8Array: (key) =>
        promisify("getUint8Array", "chrome.storage.local.get failed", () =>
          globalThis.chrome.storage.local.get(key),
        ).pipe(
          Effect.map((stored: { [k: string]: unknown }) => {
            const raw = stored[key];
            if (isBytesEnvelope(raw)) return new Uint8Array(raw.__kvBytes);
            return undefined;
          }),
        ),
      set: (key, value) =>
        promisify("set", "chrome.storage.local.set failed", () => {
          const wrapped: unknown =
            typeof value === "string" ? value : { __kvBytes: Array.from(value) };
          return globalThis.chrome.storage.local.set({ [key]: wrapped });
        }),
      remove: (key) =>
        promisify("remove", "chrome.storage.local.remove failed", () =>
          globalThis.chrome.storage.local.remove(key),
        ),
      clear: promisify("clear", "chrome.storage.local.clear failed", () =>
        globalThis.chrome.storage.local.clear(),
      ),
      size: promisify("size", "chrome.storage.local.get(null) failed", () =>
        globalThis.chrome.storage.local.get(null),
      ).pipe(Effect.map((all) => Object.keys(all).length)),
    }),
  );
