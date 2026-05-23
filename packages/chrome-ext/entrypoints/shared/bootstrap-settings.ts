/**
 * Bootstrap mode settings — `KeyValueStore`-backed round-trip.
 *
 * The user picks one of two modes from the popup setup form on first open:
 *
 *   - `local`    — drag a local Mithril V2LSM snapshot directory onto the
 *                  popup. The popup uses the File System Access API to grab
 *                  a `FileSystemDirectoryHandle`, walks it via the
 *                  `bootstrap` package helpers, and streams the bytes into
 *                  the lsm-worker's OPFS. Skipped on browsers that don't
 *                  expose `showDirectoryPicker` (Firefox / older Chromium).
 *   - `genesis`  — no snapshot; sync from genesis off the upstream relay.
 *
 * Persistence rides on Effect's `KeyValueStore` service — the chrome-ext
 * provides `ChromeLocalKeyValueStoreLayer` (backed by `chrome.storage.local`)
 * at each entrypoint; tests can substitute an in-memory layer for hermetic
 * round-trip assertions. The Schema-decoded shape is the single source of
 * truth; `Schema.decodeUnknownEffect(Schema.parseJson(BootstrapSettings))`
 * catches stale formats from a previous build.
 *
 * Composition is pipeline-style (no nested `Effect.gen`) so the dependency
 * surface — `KeyValueStoreError | SchemaError` collapsed to `undefined`
 * for the read side — is visible at the type level.
 */
import { Effect, Schema } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import { DEFAULT_RELAY_URL } from "./relay-url.ts";

export const BootstrapMode = Schema.Literals(["local", "genesis"] as const);
export type BootstrapMode = typeof BootstrapMode.Type;

export const BootstrapSettings = Schema.Struct({
  mode: BootstrapMode,
  /** WebSocket URL for the relay proxy (e.g. `ws://localhost:3040`).
   *  The offscreen connects to `${serverUrl}/relay` regardless of mode —
   *  relay sync is the only WS in the loop now that the bootstrap server
   *  has been removed. */
  serverUrl: Schema.String,
});
export type BootstrapSettings = typeof BootstrapSettings.Type;

/** Raw `chrome.storage.local` key — keep in sync with Playwright seeds. */
export const BOOTSTRAP_SETTINGS_STORAGE_KEY = "gerolamino:bootstrap-settings";

const STORAGE_KEY = BOOTSTRAP_SETTINGS_STORAGE_KEY;

export const DEFAULT_SETTINGS: BootstrapSettings = {
  mode: "genesis",
  serverUrl: DEFAULT_RELAY_URL,
};

/**
 * Schema-driven JSON codec: `string ↔ JSON parse ↔ BootstrapSettings`. The
 * canonical v4 entry point — round-trips through `Schema.fromJsonString`
 * (Schema.ts:9650). No hand-rolled `JSON.parse` / `JSON.stringify` walls.
 */
const SettingsJsonCodec = Schema.fromJsonString(BootstrapSettings);
const decodeFromJsonString = Schema.decodeUnknownEffect(SettingsJsonCodec);
const encodeToJsonString = Schema.encodeUnknownEffect(SettingsJsonCodec);

const decodeSettingsRaw = (
  raw: unknown,
): Effect.Effect<BootstrapSettings | undefined> => {
  if (raw === undefined) return Effect.succeed(undefined);
  const str = typeof raw === "string" ? raw : JSON.stringify(raw);
  return decodeFromJsonString(str).pipe(Effect.orElseSucceed(() => undefined));
};

/** Callback `chrome.storage.*.get` with timeout — Promise `.get()` can hang in offscreen. */
const chromeStorageGet = (
  area: "local" | "session",
  key: string,
  timeoutMs: number = 1_000,
): Effect.Effect<unknown> =>
  Effect.tryPromise({
    try: () =>
      new Promise<unknown>((resolve) => {
        const storage =
          area === "local"
            ? globalThis.chrome.storage.local
            : globalThis.chrome.storage.session;
        const timer = globalThis.setTimeout(() => resolve(undefined), timeoutMs);
        try {
          if (storage === undefined) {
            globalThis.clearTimeout(timer);
            resolve(undefined);
            return;
          }
          storage.get(key, (bag: Record<string, unknown>) => {
            globalThis.clearTimeout(timer);
            resolve(bag[key]);
          });
        } catch {
          globalThis.clearTimeout(timer);
          resolve(undefined);
        }
      }),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));

/** Block until `chrome.storage.local` acknowledges a write (Playwright E2E). */
export const flushChromeLocalStorage = (
  entries: Readonly<Record<string, unknown>>,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        try {
          globalThis.chrome.storage.local.set(entries, () => {
            const err = globalThis.chrome.runtime?.lastError;
            if (err !== undefined) reject(new Error(err.message));
            else resolve();
          });
        } catch (cause) {
          reject(cause);
        }
      }),
    catch: (cause) => cause,
  }).pipe(Effect.asVoid);

/**
 * Read settings directly from `chrome.storage.local` (no `KeyValueStore`).
 * Used by offscreen `forkBootstrapSync` so RpcServer handler scopes always
 * see the same persisted envelope Playwright seeds via `page.evaluate`.
 */
export const loadSettingsFromChromeStorage: Effect.Effect<BootstrapSettings | undefined> =
  chromeStorageGet("local", STORAGE_KEY).pipe(
    Effect.flatMap((raw) => decodeSettingsRaw(raw)),
    Effect.orElseSucceed(() => undefined),
  );

/** Poll `chrome.storage.local` until settings decode or attempts exhaust. */
export const loadSettingsFromChromeStorageWithRetry = (
  attempts: number = 30,
  delayMs: number = 100,
): Effect.Effect<BootstrapSettings | undefined> =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      const settings = yield* loadSettingsFromChromeStorage;
      if (settings !== undefined) return settings;
      if (i < attempts - 1) yield* Effect.sleep(`${delayMs} millis`);
    }
    return undefined;
  });

/** E2E session flag — `installE2eDeferBootstrap` in Playwright specs. */
export const readE2eDeferBootstrapFlag: Effect.Effect<boolean> =
  chromeStorageGet("session", "gerolamino:e2e-defer-bootstrap", 2_000).pipe(
    Effect.map((raw) => raw === true),
    Effect.orElseSucceed(() => false),
  );

/**
 * Read the persisted settings; resolve to `undefined` on first open or
 * decode failure. Pipeline-composed (no nested `Effect.gen`).
 */
export const loadSettings: Effect.Effect<
  BootstrapSettings | undefined,
  never,
  KeyValueStore.KeyValueStore
> = Effect.flatMap(KeyValueStore.KeyValueStore, (kvs) =>
  kvs.get(STORAGE_KEY).pipe(
    Effect.flatMap((raw) => decodeSettingsRaw(raw)),
    Effect.orElseSucceed(() => undefined),
  ),
);

/**
 * Persist settings; resolves once the underlying KVS has flushed. Errors
 * propagate as `KeyValueStoreError`; callers downgrade with `.pipe(Effect.orDie)`
 * or surface them through `Cause` for the dashboard.
 */
export const saveSettings = (
  s: BootstrapSettings,
): Effect.Effect<void, KeyValueStore.KeyValueStoreError, KeyValueStore.KeyValueStore> =>
  encodeToJsonString(s).pipe(
    Effect.orDie,
    Effect.flatMap((encoded) =>
      Effect.flatMap(KeyValueStore.KeyValueStore, (kvs) => kvs.set(STORAGE_KEY, encoded)),
    ),
  );

/** Clear the persisted settings (Reset button in the setup form). */
export const clearSettings: Effect.Effect<
  void,
  KeyValueStore.KeyValueStoreError,
  KeyValueStore.KeyValueStore
> = Effect.flatMap(KeyValueStore.KeyValueStore, (kvs) => kvs.remove(STORAGE_KEY));
