/**
 * SetupForm — first-open bootstrap-mode picker.
 *
 * Three mutually exclusive choices that map 1:1 to
 * `bootstrap-settings.ts::BootstrapMode`:
 *
 *   - **From a remote bootstrap server** (default). User supplies a
 *     `ws://…` URL; the SW connects, downloads the Mithril snapshot,
 *     then transitions to relay sync.
 *   - **From a local Mithril snapshot directory.** Uses
 *     `showDirectoryPicker()` (Chromium-only). The chosen
 *     `FileSystemDirectoryHandle` is stored in IndexedDB (handles are
 *     structured-cloneable since Chrome 95) and the SW reads from
 *     disk directly — no WS in the loop. The button is disabled when
 *     the API is missing.
 *   - **From genesis off the upstream relay.** No snapshot at all;
 *     SW jumps straight into chain-sync miniprotocol from origin.
 *     Takes hours to catch up but needs zero local state.
 *
 * On submit, the choice is persisted to `chrome.storage.local`. The
 * popup re-renders into the dashboard view; the SW reads the same
 * key on next start.
 */
import { Show, createSignal, type Component } from "solid-js";
import { Effect } from "effect";
import {
  type BootstrapMode,
  type BootstrapSettings,
  DEFAULT_SETTINGS,
  saveSettings,
} from "../shared/bootstrap-settings.ts";

const HANDLE_DB = "gerolamino:snapshot-handle";
const HANDLE_KEY = "snapshotDirectory";

/** Persist a `FileSystemDirectoryHandle` in an IndexedDB object store —
 *  `chrome.storage.local` doesn't support structured cloning of FSA
 *  handles, but IndexedDB does. */
const persistDirectoryHandle = async (handle: FileSystemDirectoryHandle): Promise<void> => {
  const request = globalThis.indexedDB.open(HANDLE_DB, 1);
  request.onupgradeneeded = () => request.result.createObjectStore("handles");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
};

const supportsDirectoryPicker = (): boolean =>
  typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

export interface SetupFormProps {
  onSubmit: (settings: BootstrapSettings) => void;
}

export const SetupForm: Component<SetupFormProps> = (props) => {
  const [mode, setMode] = createSignal<BootstrapMode>(DEFAULT_SETTINGS.mode);
  const [serverUrl, setServerUrl] = createSignal(DEFAULT_SETTINGS.serverUrl);
  const [pickedDir, setPickedDir] = createSignal<string | undefined>();
  const [error, setError] = createSignal<string | undefined>();
  const [busy, setBusy] = createSignal(false);

  const pickDirectory = async () => {
    setError(undefined);
    if (!supportsDirectoryPicker()) {
      setError("This browser doesn't expose showDirectoryPicker — Chrome 86+ required.");
      return;
    }
    try {
      const picker = (
        globalThis as {
          showDirectoryPicker: (opts?: { mode?: "read" }) => Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker;
      const handle = await picker({ mode: "read" });
      await persistDirectoryHandle(handle);
      setPickedDir(handle.name);
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      if (!aborted) setError(`Couldn't open directory: ${e instanceof Error ? e.message : e}`);
    }
  };

  const submit = () => {
    if (mode() === "local" && pickedDir() === undefined) {
      setError("Pick a snapshot directory first.");
      return;
    }
    if (mode() === "remote" && !/^wss?:\/\//.test(serverUrl())) {
      setError("Server URL must start with ws:// or wss://.");
      return;
    }
    setBusy(true);
    const settings: BootstrapSettings = { mode: mode(), serverUrl: serverUrl() };
    Effect.runFork(
      saveSettings(settings).pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            setBusy(false);
            setError(`Couldn't save: ${String(cause)}`);
          }),
        ),
        Effect.tap(() => Effect.sync(() => props.onSubmit(settings))),
      ),
    );
  };

  return (
    <div class="dark w-[380px] min-h-[480px] p-4 bg-background text-foreground font-sans space-y-4">
      <div>
        <h1 class="text-lg font-semibold">Gerolamino — set up sync</h1>
        <p class="text-sm text-muted-foreground">Pick how the node bootstraps. You can change this later.</p>
      </div>

      <fieldset class="space-y-3 border border-border rounded-md p-3">
        <legend class="px-1 text-sm font-medium">Bootstrap mode</legend>

        <label class="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="mode"
            value="remote"
            class="mt-1"
            checked={mode() === "remote"}
            onChange={() => setMode("remote")}
            data-testid="mode-remote"
          />
          <div class="flex-1 space-y-1">
            <div class="text-sm font-medium">From a remote bootstrap server</div>
            <div class="text-xs text-muted-foreground">
              Connect over WebSocket and pull the Mithril snapshot.
            </div>
            <Show when={mode() === "remote"}>
              <input
                type="text"
                value={serverUrl()}
                onInput={(e) => setServerUrl(e.currentTarget.value)}
                placeholder="ws://localhost:3040"
                class="w-full mt-1 px-2 py-1 text-xs border border-input rounded-md bg-background"
                data-testid="server-url"
              />
            </Show>
          </div>
        </label>

        <label
          class={`flex items-start gap-2 ${supportsDirectoryPicker() ? "cursor-pointer" : "opacity-50"}`}
        >
          <input
            type="radio"
            name="mode"
            value="local"
            class="mt-1"
            checked={mode() === "local"}
            disabled={!supportsDirectoryPicker()}
            onChange={() => setMode("local")}
            data-testid="mode-local"
          />
          <div class="flex-1 space-y-1">
            <div class="text-sm font-medium">From a local Mithril snapshot directory</div>
            <div class="text-xs text-muted-foreground">
              Read directly off disk. No bootstrap server needed.
            </div>
            <Show when={mode() === "local"}>
              <button
                type="button"
                onClick={pickDirectory}
                class="mt-1 px-2 py-1 text-xs border border-input rounded-md bg-secondary hover:bg-accent"
                data-testid="pick-directory"
              >
                {pickedDir() ? `📁 ${pickedDir()}` : "Pick directory…"}
              </button>
            </Show>
          </div>
        </label>

        <label class="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="mode"
            value="genesis"
            class="mt-1"
            checked={mode() === "genesis"}
            onChange={() => setMode("genesis")}
            data-testid="mode-genesis"
          />
          <div class="flex-1 space-y-1">
            <div class="text-sm font-medium">From genesis (slow, no snapshot)</div>
            <div class="text-xs text-muted-foreground">
              Sync from the upstream relay starting at the chain origin. Takes hours.
            </div>
          </div>
        </label>
      </fieldset>

      <Show when={error()}>
        <div class="text-xs text-error-foreground bg-error rounded-md p-2" data-testid="error">
          {error()}
        </div>
      </Show>

      <button
        type="button"
        onClick={submit}
        disabled={busy()}
        class="w-full px-3 py-2 text-sm font-medium border border-input rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
        data-testid="submit"
      >
        {busy() ? "Saving…" : "Start syncing"}
      </button>
    </div>
  );
};
