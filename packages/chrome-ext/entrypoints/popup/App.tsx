/**
 * Popup App — first-open setup form, then the dashboard.
 *
 * Flow:
 *   1. On mount, read `chrome.storage.local`'s persisted bootstrap
 *      settings.
 *   2. If absent (first-ever open) or the user explicitly hits the
 *      reset action, render `<SetupForm>` so the user picks a mode.
 *   3. Once settings exist, render `<BrowserDashboard>` — it talks to
 *      the SW which independently consults the same storage key.
 *
 * The popup re-mounts on every open (chrome.action default), so the
 * `loadSettings` round-trip happens once per open and is cheap (~ms).
 */
import { Effect } from "effect";
import { Show, createResource, createSignal, type Component } from "solid-js";
import { BrowserDashboard } from "./dashboard/index.tsx";
import { SetupForm } from "./SetupForm.tsx";
import {
  type BootstrapSettings,
  clearSettings,
  loadSettings,
} from "../shared/bootstrap-settings.ts";
import { ChromeLocalKeyValueStoreLayer } from "../shared/chrome-key-value-store.ts";

const App: Component = () => {
  const [overrideSettings, setOverrideSettings] = createSignal<BootstrapSettings | undefined>();
  // Local "reset signal" — `true` means the user clicked Reset; the
  // Show below treats this as a force-render of SetupForm regardless
  // of whether `loadSettings` still returns a non-undefined value.
  const [resetRequested, setResetRequested] = createSignal(false);
  // 500 ms cap on the chrome.storage.local round-trip — under normal
  // operation this returns within ~5 ms, but a corrupted store entry
  // or a stalled-hung extension state can hang the popup indefinitely.
  // The timeout + catch-all collapse both "no settings yet" and
  // "storage hung" into the same `undefined` result, so the SetupForm
  // path renders deterministically.
  const [stored] = createResource(() =>
    loadSettings.pipe(
      Effect.timeout("500 millis"),
      Effect.catch(() => Effect.succeed<BootstrapSettings | undefined>(undefined)),
      Effect.provide(ChromeLocalKeyValueStoreLayer),
      Effect.runPromise,
    ),
  );

  const settings = () => (resetRequested() ? undefined : overrideSettings() ?? stored());

  const handleReset = () => {
    Effect.runFork(
      clearSettings.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setOverrideSettings(undefined);
            setResetRequested(true);
          }),
        ),
        Effect.orDie,
        Effect.provide(ChromeLocalKeyValueStoreLayer),
      ),
    );
  };

  return (
    <Show
      when={!stored.loading}
      fallback={
        <div class="dark w-[380px] min-h-[480px] p-4 bg-background text-foreground font-sans flex items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      }
    >
      <Show
        when={settings()}
        fallback={
          <SetupForm
            onSubmit={(s) => {
              setResetRequested(false);
              setOverrideSettings(s);
            }}
          />
        }
      >
        <div class="dark w-[380px] min-h-[480px] bg-background text-foreground font-sans flex flex-col">
          <div class="flex justify-end p-2 border-b border-border">
            <button
              type="button"
              onClick={handleReset}
              class="text-xs px-2 py-1 border border-input rounded-md hover:bg-muted/30"
              data-testid="reset-settings"
              title="Re-open the bootstrap-mode picker"
            >
              Reset bootstrap mode
            </button>
          </div>
          <BrowserDashboard />
        </div>
      </Show>
    </Show>
  );
};

export default App;
