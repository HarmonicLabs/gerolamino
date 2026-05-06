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
import { type BootstrapSettings, loadSettings } from "../shared/bootstrap-settings.ts";

const App: Component = () => {
  const [overrideSettings, setOverrideSettings] = createSignal<BootstrapSettings | undefined>();
  const [stored] = createResource(() =>
    Effect.runPromise(loadSettings).catch(() => undefined),
  );

  const settings = () => overrideSettings() ?? stored();

  return (
    <Show
      when={!stored.loading}
      fallback={
        <div class="dark w-[380px] min-h-[480px] p-4 bg-background text-foreground font-sans flex items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      }
    >
      <Show when={settings()} fallback={<SetupForm onSubmit={setOverrideSettings} />}>
        <BrowserDashboard />
      </Show>
    </Show>
  );
};

export default App;
