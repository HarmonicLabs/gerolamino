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

const STORAGE_KEY = "gerolamino:bootstrap-settings";

export const DEFAULT_SETTINGS: BootstrapSettings = {
  mode: "genesis",
  serverUrl: "ws://localhost:3040",
};

/**
 * Schema-driven JSON codec: `string ↔ JSON parse ↔ BootstrapSettings`. The
 * canonical v4 entry point — round-trips through `Schema.fromJsonString`
 * (Schema.ts:9650). No hand-rolled `JSON.parse` / `JSON.stringify` walls.
 */
const SettingsJsonCodec = Schema.fromJsonString(BootstrapSettings);
const decodeFromJsonString = Schema.decodeUnknownEffect(SettingsJsonCodec);
const encodeToJsonString = Schema.encodeUnknownEffect(SettingsJsonCodec);

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
    Effect.flatMap((raw) =>
      raw === undefined
        ? Effect.succeed<BootstrapSettings | undefined>(undefined)
        : decodeFromJsonString(raw).pipe(Effect.orElseSucceed(() => undefined)),
    ),
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
