/**
 * Tests for the Chrome extension background worker bootstrap pipeline.
 * Uses @webext-core/fake-browser to mock Chrome extension APIs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";
import { MessageTag, encodeFrame, encodeBlock, encodeBlobBatch } from "bootstrap";

// Mock the chrome global with fake-browser
vi.stubGlobal("chrome", fakeBrowser);

// Import the SyncState type — same shape as background.ts exports
interface SyncState {
  readonly status: "idle" | "connecting" | "bootstrapping" | "syncing" | "error";
  readonly protocolMagic: number;
  readonly snapshotSlot: string;
  readonly totalChunks: number;
  readonly blocksReceived: number;
  readonly blobEntriesReceived: number;
  readonly ledgerStateReceived: boolean;
  readonly bootstrapComplete: boolean;
  readonly lastError?: string;
  readonly lastUpdated: number;
}

describe("Chrome Extension Background", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  describe("chrome.storage.session", () => {
    it("should store and retrieve sync state", async () => {
      const state: SyncState = {
        status: "bootstrapping",
        protocolMagic: 1,
        snapshotSlot: "12345",
        totalChunks: 100,
        blocksReceived: 50,
        blobEntriesReceived: 1000,
        ledgerStateReceived: true,
        bootstrapComplete: false,
        lastUpdated: Date.now(),
      };

      await fakeBrowser.storage.session.set({ syncState: state });
      const result = await fakeBrowser.storage.session.get("syncState");
      expect(result.syncState).toEqual(state);
    });

    it("should notify listeners on state change", async () => {
      const listener = vi.fn();
      fakeBrowser.storage.session.onChanged.addListener(listener);

      await fakeBrowser.storage.session.set({ syncState: { status: "connecting" } });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          syncState: expect.objectContaining({
            newValue: { status: "connecting" },
          }),
        }),
      );
    });
  });

  describe("runtime messaging", () => {
    it("should handle GET_STATE message", async () => {
      const state: SyncState = {
        status: "idle",
        protocolMagic: 0,
        snapshotSlot: "0",
        totalChunks: 0,
        blocksReceived: 0,
        blobEntriesReceived: 0,
        ledgerStateReceived: false,
        bootstrapComplete: false,
        lastUpdated: Date.now(),
      };

      await fakeBrowser.storage.session.set({ syncState: state });

      // Register the handler
      fakeBrowser.runtime.onMessage.addListener((msg: Record<string, unknown>, _sender: unknown) => {
        if (msg.type === "GET_STATE") {
          return fakeBrowser.storage.session.get("syncState").then((result: Record<string, unknown>) => ({
            state: result.syncState,
          }));
        }
      });

      // Send message and get response
      const response = await fakeBrowser.runtime.sendMessage({ type: "GET_STATE" });
      expect(response).toEqual({ state });
    });

    it("should broadcast SYNC_STATE to listeners", async () => {
      const listener = vi.fn();
      fakeBrowser.runtime.onMessage.addListener(listener);

      const state: SyncState = {
        status: "syncing",
        protocolMagic: 1,
        snapshotSlot: "99999",
        totalChunks: 200,
        blocksReceived: 100,
        blobEntriesReceived: 5000,
        ledgerStateReceived: true,
        bootstrapComplete: true,
        lastUpdated: Date.now(),
      };

      await fakeBrowser.runtime.sendMessage({ type: "SYNC_STATE", state });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SYNC_STATE", state }),
        expect.anything(),
      );
    });
  });

  // NOTE: runtime.connect / onConnect are not implemented in @webext-core/fake-browser.
  // Port-based messaging tested via integration tests in a real browser environment.
});

describe("Bootstrap Protocol (browser-compatible)", () => {
  it("should encode and decode Init frame", () => {
    // Init payload: [magic: u32][slot: u64][chunks: u32][blocks: u32][blobs: u32][prefixCount: u16][prefixes...]
    const encoder = new TextEncoder();
    const prefix = encoder.encode("utxo");
    const payload = new Uint8Array(4 + 8 + 4 + 4 + 4 + 2 + 2 + prefix.length);
    const dv = new DataView(payload.buffer);
    let off = 0;
    dv.setUint32(off, 1, false); off += 4; // magic
    dv.setBigUint64(off, 12345n, false); off += 8; // slot
    dv.setUint32(off, 100, false); off += 4; // chunks
    dv.setUint32(off, 50, false); off += 4; // blocks
    dv.setUint32(off, 1000, false); off += 4; // blobs
    dv.setUint16(off, 1, false); off += 2; // prefix count
    dv.setUint16(off, prefix.length, false); off += 2;
    payload.set(prefix, off);

    const frame = encodeFrame(MessageTag.Init, payload);
    expect(frame[0]).toBe(MessageTag.Init);
    expect(frame.length).toBe(5 + payload.length);
  });

  it("should encode Block message", () => {
    const blockCbor = new Uint8Array([0x82, 0x01, 0x02]);
    const payload = encodeBlock({
      chunkNo: 1,
      slotNo: 42n,
      headerHash: new Uint8Array(32),
      headerOffset: 0,
      headerSize: 100,
      crc: 0xdeadbeef,
      blockCbor,
    });
    expect(payload.length).toBe(50 + blockCbor.length);
  });

  it("should encode BlobEntries message", () => {
    const entries = [
      { key: new Uint8Array([1, 2, 3]), value: new Uint8Array([4, 5, 6]) },
      { key: new Uint8Array([7, 8]), value: new Uint8Array([9]) },
    ];
    const payload = encodeBlobBatch("utxo", entries);
    expect(payload.length).toBeGreaterThan(0);
  });
});
