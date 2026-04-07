import { describe, it, assert } from "@effect/vitest";
import {
  MessageTag,
  encodeFrame,
  decodeFrame,
  extractFrames,
  concatBytes,
  encodeBlock,
  decodeBlock,
  encodeInit,
  decodeInit,
  encodeBlobBatch,
  decodeBlobBatch,
  encodeProgress,
  decodeProgress,
} from "../protocol.ts";

describe("Protocol", () => {
  describe("TLV framing", () => {
    it("encodes and extracts single frame", () => {
      const payload = new Uint8Array([1, 2, 3]);
      const frame = encodeFrame(MessageTag.Complete, payload);

      assert.strictEqual(frame[0], MessageTag.Complete);
      assert.strictEqual(frame.length, 5 + 3);

      const { frames, remaining } = extractFrames(frame);
      assert.strictEqual(frames.length, 1);
      assert.strictEqual(remaining.length, 0);
    });

    it("extracts multiple frames from concatenated buffer", () => {
      const f1 = encodeFrame(MessageTag.Init, new Uint8Array([10]));
      const f2 = encodeFrame(MessageTag.Complete, new Uint8Array(0));
      const combined = concatBytes(f1, f2);

      const { frames, remaining } = extractFrames(combined);
      assert.strictEqual(frames.length, 2);
      assert.strictEqual(remaining.length, 0);
    });

    it("handles partial frame at end of buffer", () => {
      const frame = encodeFrame(MessageTag.Init, new Uint8Array([1, 2, 3]));
      const partial = frame.subarray(0, frame.length - 1);

      const { frames, remaining } = extractFrames(partial);
      assert.strictEqual(frames.length, 0);
      assert.strictEqual(remaining.length, partial.length);
    });

    it("handles empty buffer", () => {
      const { frames, remaining } = extractFrames(new Uint8Array(0));
      assert.strictEqual(frames.length, 0);
      assert.strictEqual(remaining.length, 0);
    });
  });

  describe("Block message", () => {
    it("round-trips block data", () => {
      const block = {
        chunkNo: 42,
        slotNo: 119401006n,
        headerHash: new Uint8Array(32).fill(0xab),
        headerOffset: 3,
        headerSize: 76,
        crc: 12345678,
        blockCbor: new Uint8Array([0x82, 0x00, 0x83]),
      };
      const frame = encodeFrame(MessageTag.Block, encodeBlock(block));
      const decoded = decodeFrame(frame);

      assert.strictEqual(decoded.tag, MessageTag.Block);
      if (decoded.tag !== MessageTag.Block) return;
      assert.strictEqual(decoded.chunkNo, 42);
      assert.strictEqual(decoded.slotNo, 119401006n);
      assert.deepStrictEqual(decoded.headerHash, block.headerHash);
      assert.strictEqual(decoded.headerOffset, 3);
      assert.strictEqual(decoded.headerSize, 76);
      assert.strictEqual(decoded.crc, 12345678);
      assert.deepStrictEqual(decoded.blockCbor, block.blockCbor);
    });
  });

  describe("Init message", () => {
    it("round-trips init metadata", () => {
      const init = {
        protocolMagic: 1,
        snapshotSlot: 119401006n,
        totalChunks: 5529,
        totalBlocks: 100000,
        totalBlobEntries: 2000000,
        blobPrefixes: ["_dbstate", "utxo"],
      };
      const frame = encodeFrame(MessageTag.Init, encodeInit(init));
      const decoded = decodeFrame(frame);

      assert.strictEqual(decoded.tag, MessageTag.Init);
      if (decoded.tag !== MessageTag.Init) return;
      assert.strictEqual(decoded.protocolMagic, 1);
      assert.strictEqual(decoded.snapshotSlot, 119401006n);
      assert.strictEqual(decoded.totalChunks, 5529);
      assert.deepStrictEqual(decoded.blobPrefixes, ["_dbstate", "utxo"]);
    });
  });

  describe("BlobEntries message", () => {
    it("round-trips blob batch", () => {
      const entries = [
        { key: new Uint8Array(34).fill(0x01), value: new Uint8Array(100).fill(0x02) },
        { key: new Uint8Array(34).fill(0x03), value: new Uint8Array(50).fill(0x04) },
      ];
      const frame = encodeFrame(MessageTag.BlobEntries, encodeBlobBatch("utxo", entries));
      const decoded = decodeFrame(frame);

      assert.strictEqual(decoded.tag, MessageTag.BlobEntries);
      if (decoded.tag !== MessageTag.BlobEntries) return;
      assert.strictEqual(decoded.dbName, "utxo");
      assert.strictEqual(decoded.count, 2);
      assert.deepStrictEqual(decoded.entries[0]!.key, entries[0]!.key);
      assert.deepStrictEqual(decoded.entries[1]!.value, entries[1]!.value);
    });
  });

  describe("Progress message", () => {
    it("round-trips progress", () => {
      const frame = encodeFrame(MessageTag.Progress, encodeProgress("blocks", 500, 5529));
      const decoded = decodeFrame(frame);

      assert.strictEqual(decoded.tag, MessageTag.Progress);
      if (decoded.tag !== MessageTag.Progress) return;
      assert.strictEqual(decoded.phase, "blocks");
      assert.strictEqual(decoded.current, 500);
      assert.strictEqual(decoded.total, 5529);
    });
  });

  describe("LedgerState and LedgerMeta", () => {
    it("round-trips ledger state", () => {
      const payload = new Uint8Array([0x82, 0x01, 0x82, 0x87]);
      const frame = encodeFrame(MessageTag.LedgerState, payload);
      const decoded = decodeFrame(frame);

      assert.strictEqual(decoded.tag, MessageTag.LedgerState);
      if (decoded.tag !== MessageTag.LedgerState) return;
      assert.deepStrictEqual(decoded.payload, payload);
    });

    it("round-trips ledger meta", () => {
      const meta = new TextEncoder().encode('{"backend":"utxohd-lmdb"}');
      const frame = encodeFrame(MessageTag.LedgerMeta, meta);
      const decoded = decodeFrame(frame);

      assert.strictEqual(decoded.tag, MessageTag.LedgerMeta);
      if (decoded.tag !== MessageTag.LedgerMeta) return;
      const parsed = JSON.parse(new TextDecoder().decode(decoded.payload));
      assert.strictEqual(parsed.backend, "utxohd-lmdb");
    });
  });

  describe("Complete message", () => {
    it("round-trips complete", () => {
      const frame = encodeFrame(MessageTag.Complete, new Uint8Array(0));
      const decoded = decodeFrame(frame);
      assert.strictEqual(decoded.tag, MessageTag.Complete);
    });
  });
});
