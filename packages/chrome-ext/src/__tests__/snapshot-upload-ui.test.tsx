/**
 * SnapshotUpload UI unit tests — popup vs tab affordances (no real upload).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { render, screen } from "@solidjs/testing-library";
import { SnapshotUpload } from "../../entrypoints/popup/SnapshotUpload.tsx";

vi.mock("../../entrypoints/popup/upload-rpc-client.ts", () => ({
  makeOffscreenUploadClient: () =>
    Effect.succeed({
      InspectOpfsSnapshot: () =>
        Effect.succeed({
          hasSession: false,
          hasSnapshots: false,
          byteCount: 0,
          lastModifiedMs: 0,
        }),
    }),
  waitForOffscreenUploadReady: () => Effect.void,
}));

vi.mock("../../entrypoints/shared/ensure-offscreen-message.ts", () => ({
  requestEnsureOffscreen: () => Promise.resolve(),
}));

vi.mock("../../entrypoints/popup/upload-rpc-layer.ts", () => ({
  isE2eDirectOffscreenRpc: () => false,
  uploadRpcLayer: () => Layer.empty,
}));

const stubWindowLocation = (search: string, href: string): void => {
  Object.defineProperty(globalThis, "location", {
    value: { ...globalThis.location, search, href },
    configurable: true,
  });
};

describe("SnapshotUpload UI", () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const innerHeightDescriptor = Object.getOwnPropertyDescriptor(globalThis, "innerHeight");

  beforeEach(() => {
    vi.stubGlobal("showDirectoryPicker", vi.fn());
  });

  afterEach(() => {
    if (locationDescriptor !== undefined) {
      Object.defineProperty(globalThis, "location", locationDescriptor);
    }
    if (innerHeightDescriptor !== undefined) {
      Object.defineProperty(globalThis, "innerHeight", innerHeightDescriptor);
    }
  });

  it("renders the snapshot drop zone", () => {
    render(() => <SnapshotUpload onUploaded={() => undefined} />);
    expect(screen.getByTestId("snapshot-dropzone")).toBeInTheDocument();
    expect(screen.getByText(/Drop a Mithril snapshot folder here/i)).toBeInTheDocument();
  });

  it("shows open-in-tab affordance in popup-sized viewport", () => {
    stubWindowLocation("", "chrome-extension://test/popup.html");
    Object.defineProperty(globalThis, "innerHeight", { value: 520, configurable: true });
    render(() => <SnapshotUpload onUploaded={() => undefined} />);
    expect(screen.getByTestId("open-in-tab")).toBeInTheDocument();
  });

  it("hides open-in-tab on fullpage setup tab", () => {
    stubWindowLocation("?fullpage=1", "chrome-extension://test/popup.html?fullpage=1");
    Object.defineProperty(globalThis, "innerHeight", { value: 520, configurable: true });
    render(() => <SnapshotUpload onUploaded={() => undefined} />);
    expect(screen.queryByTestId("open-in-tab")).not.toBeInTheDocument();
  });
});
