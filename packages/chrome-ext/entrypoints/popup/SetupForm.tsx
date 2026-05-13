/**
 * SetupForm — first-open bootstrap-mode picker.
 *
 * Two mutually exclusive choices that map 1:1 to
 * `bootstrap-settings.ts::BootstrapMode`:
 *
 *   - **From a local Mithril snapshot directory.** Uses
 *     `showDirectoryPicker()` (Chromium-only). The chosen
 *     `FileSystemDirectoryHandle` is walked by the `bootstrap`
 *     package helpers; bytes stream into the lsm-worker's OPFS.
 *     Disabled when the API is missing.
 *   - **From genesis off the upstream relay.** No snapshot at all;
 *     the offscreen jumps straight into chain-sync miniprotocol
 *     from origin. Takes hours to catch up but needs zero local state.
 *
 * On submit, the choice is persisted to `chrome.storage.local`. The
 * popup re-renders into the dashboard view; the offscreen reads the
 * same key on next start.
 */
import { Show, createSignal, type Component } from "solid-js";
import { Effect } from "effect";
import {
  type BootstrapMode,
  type BootstrapSettings,
  DEFAULT_SETTINGS,
  saveSettings,
} from "../shared/bootstrap-settings.ts";
import { SnapshotUpload } from "./SnapshotUpload.tsx";

/** Whether the host browser exposes the File System Access API
 *  surface our snapshot uploader needs. Falsy → disable the local
 *  mode radio. */
const supportsDirectoryPicker = (): boolean =>
  typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

export interface SetupFormProps {
  onSubmit: (settings: BootstrapSettings) => void;
}

export const SetupForm: Component<SetupFormProps> = (props) => {
  // Honor `?mode=local|genesis` from the URL so the "Open setup in a
  // dedicated tab" link from `SnapshotUpload` can pre-select the
  // mode the user had picked in the (closed) popup. Defaults to
  // `DEFAULT_SETTINGS.mode` otherwise.
  const initialMode = ((): BootstrapMode => {
    const q = typeof globalThis.window !== "undefined"
      ? new URLSearchParams(globalThis.window.location.search).get("mode")
      : null;
    return q === "local" || q === "genesis" ? q : DEFAULT_SETTINGS.mode;
  })();
  const [mode, setMode] = createSignal<BootstrapMode>(initialMode);
  const [snapshotUploaded, setSnapshotUploaded] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  const [busy, setBusy] = createSignal(false);

  const submit = () => {
    if (mode() === "local" && !snapshotUploaded()) {
      setError("Upload a snapshot first via the drop zone.");
      return;
    }
    setBusy(true);
    const settings: BootstrapSettings = {
      mode: mode(),
      serverUrl: DEFAULT_SETTINGS.serverUrl,
    };
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
            value="local"
            class="mt-1"
            checked={mode() === "local"}
            onChange={() => setMode("local")}
            data-testid="mode-local"
          />
          <div class="flex-1 space-y-1">
            <div class="text-sm font-medium">From a local Mithril snapshot</div>
            <div class="text-xs text-muted-foreground">
              Drop a folder onto the zone below. Streams to OPFS via the
              lsm-worker — no bootstrap server needed.
            </div>
            <Show when={mode() === "local" && !supportsDirectoryPicker()}>
              <div class="text-xs text-error-foreground bg-error/30 rounded p-1.5 mt-1">
                Your browser doesn't expose <code>showDirectoryPicker</code> —
                drag-and-drop the snapshot folder onto the drop zone instead.
              </div>
            </Show>
            <Show when={mode() === "local"}>
              <SnapshotUpload onUploaded={() => setSnapshotUploaded(true)} />
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
