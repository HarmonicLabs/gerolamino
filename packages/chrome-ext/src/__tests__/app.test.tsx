/**
 * App shell unit tests — setup form vs dashboard routing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "./helpers/solid-render.ts";
import App from "../../entrypoints/popup/App.tsx";
import { saveSettings } from "../../entrypoints/shared/bootstrap-settings.ts";
import { ChromeLocalKeyValueStoreLayer } from "../../entrypoints/shared/chrome-key-value-store.ts";

vi.mock("../../entrypoints/popup/dashboard/index.tsx", () => ({
  BrowserDashboard: () => <div data-testid="mock-dashboard">Browser dashboard</div>,
}));

vi.mock("../../entrypoints/popup/SetupForm.tsx", () => ({
  SetupForm: (props: { onSubmit: (s: { mode: string; serverUrl: string }) => void }) => (
    <div data-testid="mock-setup-form">
      <button
        type="button"
        data-testid="mock-setup-submit"
        onClick={() => props.onSubmit({ mode: "genesis", serverUrl: "ws://localhost:3040" })}
      >
        Complete setup
      </button>
    </div>
  ),
}));

const clearChromeLocal = (): Promise<void> =>
  new Promise((resolve) => {
    globalThis.chrome.storage.local.clear(() => resolve());
  });

const seedSettings = (): Promise<void> =>
  Effect.gen(function* () {
    yield* saveSettings({ mode: "genesis", serverUrl: "ws://localhost:3040" });
  }).pipe(Effect.provide(ChromeLocalKeyValueStoreLayer), Effect.runPromise);

describe("App", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearChromeLocal();
  });

  it("shows SetupForm when no persisted settings", async () => {
    render(() => <App />);
    await waitFor(() => {
      expect(screen.getByTestId("mock-setup-form")).toBeInTheDocument();
    });
  });

  it("shows dashboard and reset control when settings exist", async () => {
    await seedSettings();
    render(() => <App />);
    await waitFor(() => {
      expect(screen.getByTestId("mock-dashboard")).toBeInTheDocument();
      expect(screen.getByTestId("reset-settings")).toBeInTheDocument();
    });
  });

  it("returns to setup form after reset", async () => {
    await seedSettings();
    const user = userEvent.setup();
    render(() => <App />);
    await waitFor(() => expect(screen.getByTestId("reset-settings")).toBeInTheDocument());
    await user.click(screen.getByTestId("reset-settings"));
    await waitFor(() => {
      expect(screen.getByTestId("mock-setup-form")).toBeInTheDocument();
    });
  });
});
