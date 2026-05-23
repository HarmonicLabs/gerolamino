/**
 * SetupForm unit tests — Solid + jsdom + user-event.
 *
 * RPC/upload paths are mocked; assertions focus on mode selection, validation,
 * and submit gating (snapshot required for local mode).
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@solidjs/testing-library";
import { SetupForm } from "../../entrypoints/popup/SetupForm.tsx";

vi.mock("../../entrypoints/popup/SnapshotUpload.tsx", () => ({
  SnapshotUpload: (props: { onUploaded: () => void }) => (
    <button type="button" data-testid="mock-snapshot-uploaded" onClick={() => props.onUploaded()}>
      Mark snapshot uploaded
    </button>
  ),
}));

vi.mock("../../entrypoints/popup/upload-rpc-client.ts", () => ({
  makeNodeUploadClient: () =>
    Effect.succeed({
      Ping: () => Effect.succeed({ ok: true, timeMs: 0 }),
      StartSync: () => Effect.succeed({ ok: true }),
    }),
  waitForProductionOffscreenRelay: () => Effect.void,
}));

vi.mock("../../entrypoints/popup/upload-rpc-layer.ts", () => ({
  nodeRpcLayer: Layer.empty,
}));

const restoreWindowSearch = (): void => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  if (descriptor !== undefined) {
    Object.defineProperty(globalThis, "location", descriptor);
  }
};

describe("SetupForm", () => {
  afterEach(() => {
    restoreWindowSearch();
  });

  it("renders local and genesis mode radios", () => {
    render(() => <SetupForm onSubmit={() => undefined} />);
    expect(screen.getByTestId("mode-local")).toBeInTheDocument();
    expect(screen.getByTestId("mode-genesis")).toBeInTheDocument();
    expect(screen.getByTestId("submit")).toHaveTextContent("Start syncing");
  });

  it("shows snapshot dropzone mock when local mode is selected", async () => {
    const user = userEvent.setup();
    render(() => <SetupForm onSubmit={() => undefined} />);
    await user.click(screen.getByTestId("mode-local"));
    expect(screen.getByTestId("mock-snapshot-uploaded")).toBeInTheDocument();
  });

  it("blocks submit for local mode until snapshot is marked uploaded", async () => {
    const user = userEvent.setup();
    render(() => <SetupForm onSubmit={() => undefined} />);
    await user.click(screen.getByTestId("mode-local"));
    await user.click(screen.getByTestId("submit"));
    expect(screen.getByTestId("error")).toHaveTextContent(/Upload a snapshot first/);
  });

  it("calls onSubmit after genesis submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(() => <SetupForm onSubmit={onSubmit} />);
    await user.click(screen.getByTestId("mode-genesis"));
    await user.click(screen.getByTestId("submit"));
    expect(onSubmit).toHaveBeenCalledWith({
      mode: "genesis",
      serverUrl: "ws://localhost:3040",
    });
  });

  it("calls onSubmit after local upload + submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(() => <SetupForm onSubmit={onSubmit} />);
    await user.click(screen.getByTestId("mode-local"));
    await user.click(screen.getByTestId("mock-snapshot-uploaded"));
    await user.click(screen.getByTestId("submit"));
    expect(onSubmit).toHaveBeenCalledWith({
      mode: "local",
      serverUrl: "ws://localhost:3040",
    });
  });

  it("honors ?mode=genesis in the URL", () => {
    Object.defineProperty(globalThis, "location", {
      value: { ...globalThis.location, search: "?mode=genesis" },
      configurable: true,
    });
    render(() => <SetupForm onSubmit={() => undefined} />);
    expect(screen.getByTestId("mode-genesis")).toBeChecked();
  });
});
