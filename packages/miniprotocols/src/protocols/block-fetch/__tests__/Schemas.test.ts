/**
 * Test-coverage gap #17 (continued) — BlockFetch wire-format codec.
 *
 * Per Ouroboros §4.5, the block-fetch protocol exchanges 6 messages:
 * `RequestRange {from, to}`, `ClientDone`, `StartBatch`, `NoBlocks`,
 * `Block {block}`, `BatchDone`. The wire format is detailed in
 * `Schemas.ts:62-67`. Without these tests, a `cborSyncCodec` evolution
 * that re-orders array elements or changes a tag value would silently
 * break block fetch.
 */
import { describe, it, expect } from "@effect/vitest";
import { Schema } from "effect";
import { CborKinds } from "codecs";

import {
  BlockFetchMessage,
  BlockFetchMessageBytes,
  BlockFetchMessageType,
} from "../Schemas.ts";
import { ChainPointSchema, ChainPointType } from "../../types/ChainPoint.ts";

const decodeBytes = Schema.decodeSync(BlockFetchMessageBytes);
const encodeBytes = Schema.encodeSync(BlockFetchMessageBytes);

const originPoint = ChainPointSchema.cases[ChainPointType.Origin].make({});
const realPoint = (slot: number, hashByte: number) =>
  ChainPointSchema.cases[ChainPointType.RealPoint].make({
    slot,
    hash: new Uint8Array(32).fill(hashByte),
  });

describe("BlockFetchMessageBytes — wire-format codec", () => {
  describe("encode", () => {
    it("RequestRange(Origin, Origin) → CBOR [0, [], []] = 0x83 0x00 0x80 0x80", () => {
      const msg = BlockFetchMessage.cases[BlockFetchMessageType.RequestRange].make({
        from: originPoint,
        to: originPoint,
      });
      const bytes = encodeBytes(msg);
      // 0x83 = array(3); 0x00 = uint(0) tag; 0x80 = array(0) Origin × 2.
      expect(bytes.toHex()).toBe("83008080");
    });

    it("ClientDone → 0x81 0x01", () => {
      const msg = BlockFetchMessage.cases[BlockFetchMessageType.ClientDone].make({});
      expect(encodeBytes(msg).toHex()).toBe("8101");
    });

    it("StartBatch → 0x81 0x02", () => {
      const msg = BlockFetchMessage.cases[BlockFetchMessageType.StartBatch].make({});
      expect(encodeBytes(msg).toHex()).toBe("8102");
    });

    it("NoBlocks → 0x81 0x03", () => {
      const msg = BlockFetchMessage.cases[BlockFetchMessageType.NoBlocks].make({});
      expect(encodeBytes(msg).toHex()).toBe("8103");
    });

    it("BatchDone → 0x81 0x05", () => {
      const msg = BlockFetchMessage.cases[BlockFetchMessageType.BatchDone].make({});
      expect(encodeBytes(msg).toHex()).toBe("8105");
    });

    it("Block(3-byte payload) → 0x82 0x04 0x43 0xaa 0xbb 0xcc", () => {
      const msg = BlockFetchMessage.cases[BlockFetchMessageType.Block].make({
        block: new Uint8Array([0xaa, 0xbb, 0xcc]),
      });
      // 0x82 = array(2); 0x04 = uint(4); 0x43 = bytes(3); payload.
      expect(encodeBytes(msg).toHex()).toBe("820443aabbcc");
    });
  });

  describe("decode", () => {
    it("[1] → ClientDone", () => {
      const msg = decodeBytes(Uint8Array.fromHex("8101"));
      expect(msg._tag).toBe(BlockFetchMessageType.ClientDone);
    });

    it("[3] → NoBlocks", () => {
      const msg = decodeBytes(Uint8Array.fromHex("8103"));
      expect(msg._tag).toBe(BlockFetchMessageType.NoBlocks);
    });

    it("[5] → BatchDone", () => {
      const msg = decodeBytes(Uint8Array.fromHex("8105"));
      expect(msg._tag).toBe(BlockFetchMessageType.BatchDone);
    });

    it("[4, bytes] → Block", () => {
      const msg = decodeBytes(Uint8Array.fromHex("820443aabbcc"));
      expect(msg._tag).toBe(BlockFetchMessageType.Block);
      if (msg._tag === BlockFetchMessageType.Block) {
        expect(msg.block).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
      }
    });

    it("[4, Tag(24, bytes)] → Block (CBOR-in-CBOR unwrap)", () => {
      // 0x82 = array(2); 0x04 = uint(4); 0xd8 0x18 = tag(24);
      // 0x43 = bytes(3); payload aabbcc.
      const msg = decodeBytes(Uint8Array.fromHex("8204d81843aabbcc"));
      expect(msg._tag).toBe(BlockFetchMessageType.Block);
      if (msg._tag === BlockFetchMessageType.Block) {
        // The Tag(24) wrapper is unwrapped — N2N relays sometimes
        // double-wrap blocks; the codec normalises to bare bytes.
        expect(msg.block).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
      }
    });

    it("unknown tag throws", () => {
      // 0x81 0x06 — tag 6 not in the dispatch table.
      expect(() => decodeBytes(Uint8Array.fromHex("8106"))).toThrow();
    });
  });

  describe("round-trip stability", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      [
        "RequestRange(Origin, Origin)",
        BlockFetchMessage.cases[BlockFetchMessageType.RequestRange].make({
          from: originPoint,
          to: originPoint,
        }),
      ],
      [
        "RequestRange(real, real)",
        BlockFetchMessage.cases[BlockFetchMessageType.RequestRange].make({
          from: realPoint(100, 0xaa),
          to: realPoint(200, 0xbb),
        }),
      ],
      [
        "ClientDone",
        BlockFetchMessage.cases[BlockFetchMessageType.ClientDone].make({}),
      ],
      [
        "StartBatch",
        BlockFetchMessage.cases[BlockFetchMessageType.StartBatch].make({}),
      ],
      [
        "NoBlocks",
        BlockFetchMessage.cases[BlockFetchMessageType.NoBlocks].make({}),
      ],
      [
        "Block(empty)",
        BlockFetchMessage.cases[BlockFetchMessageType.Block].make({
          block: new Uint8Array(0),
        }),
      ],
      [
        "Block(64-byte payload)",
        BlockFetchMessage.cases[BlockFetchMessageType.Block].make({
          block: new Uint8Array(64).fill(0x42),
        }),
      ],
      [
        "BatchDone",
        BlockFetchMessage.cases[BlockFetchMessageType.BatchDone].make({}),
      ],
    ];

    for (const [name, msg] of cases) {
      it(`${name} round-trips byte-exactly`, () => {
        const bytes = encodeBytes(msg as never);
        const decoded = decodeBytes(bytes);
        expect(decoded).toEqual(msg);
      });
    }
  });

  // CborKinds re-export sanity — pin the major-type constant the
  // codec dispatches on so a major-version codecs bump that
  // renumbers `Array` would surface here at compile-time + at this
  // narrow boundary.
  it("uses CborKinds.Array for the outer container", () => {
    expect(CborKinds.Array).toBe(4);
  });
});
