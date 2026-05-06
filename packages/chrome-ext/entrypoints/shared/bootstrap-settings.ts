/**
 * Bootstrap mode settings — `chrome.storage.local` round-trip.
 *
 * The user picks one of three modes from the popup setup form on first
 * open:
 *
 *   - `remote`   — connect to a bootstrap server over WebSocket. Fast
 *                  if a server is reachable; ships every block CBOR
 *                  over the wire so the popup is bandwidth-bound.
 *   - `local`    — point at a local Mithril V2LSM snapshot directory.
 *                  The popup uses the File System Access API to grab a
 *                  `FileSystemDirectoryHandle`, hands it to the SW, and
 *                  the SW reads from disk directly — no WS server in
 *                  the loop. Skipped on browsers that don't expose
 *                  `showDirectoryPicker` (Firefox / older Chromium).
 *   - `genesis`  — no snapshot; sync from genesis off the upstream
 *                  relay. The popup is responsive immediately but the
 *                  SW takes hours to catch up.
 *
 * The Schema is the single source of truth for both encode + decode;
 * `Schema.decodeUnknown` catches stale shapes from a previous build.
 *
 * Persistence rationale: `chrome.storage.local` survives SW evictions
 * and popup closes, so the user's choice sticks across the MV3 SW
 * 30 s idle timeout. Survives extension reload too — the user only
 * re-picks if they uninstall + reinstall.
 */
import { Effect, Schema } from "effect";

export const BootstrapMode = Schema.Literals(["remote", "local", "genesis"] as const);
export type BootstrapMode = typeof BootstrapMode.Type;

export const BootstrapSettings = Schema.Struct({
  mode: BootstrapMode,
  /** WebSocket URL for `mode: "remote"` (e.g. `ws://localhost:3040`).
   *  Ignored for `local` / `genesis`. */
  serverUrl: Schema.String,
});
export type BootstrapSettings = typeof BootstrapSettings.Type;

const STORAGE_KEY = "gerolamino:bootstrap-settings";

export const DEFAULT_SETTINGS: BootstrapSettings = {
  mode: "genesis",
  serverUrl: "ws://localhost:3040",
};

const decode = Schema.decodeUnknownEffect(BootstrapSettings);

/** Read the persisted settings, or `None` on first open / decode error. */
export const loadSettings: Effect.Effect<BootstrapSettings | undefined> = Effect.gen(function* () {
  const stored: { [STORAGE_KEY]?: unknown } = yield* Effect.promise(() =>
    globalThis.chrome.storage.local.get(STORAGE_KEY),
  );
  const raw = stored[STORAGE_KEY];
  if (raw === undefined) return undefined;
  return yield* decode(raw).pipe(Effect.catchTag("SchemaError", () => Effect.succeed(undefined)));
});

/** Persist settings. Resolves once Chromium has flushed to its
 *  IndexedDB-backed storage. */
export const saveSettings = (s: BootstrapSettings): Effect.Effect<void> =>
  Effect.promise(() => globalThis.chrome.storage.local.set({ [STORAGE_KEY]: s }));

/** Clear the persisted settings — used by the "reset" button in the
 *  setup form so the user is prompted again on next popup open. */
export const clearSettings: Effect.Effect<void> = Effect.promise(() =>
  globalThis.chrome.storage.local.remove(STORAGE_KEY),
);
