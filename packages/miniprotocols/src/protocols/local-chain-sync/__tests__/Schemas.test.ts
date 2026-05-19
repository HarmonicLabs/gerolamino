/**
 * Test-coverage gap #17 (continued) — LocalChainSync wire-format codec.
 *
 * 8 messages: RequestNext / AwaitReply / RollForward{block, tip} /
 * RollBackward{point, tip} / FindIntersect{points} /
 * IntersectFound{point, tip} / IntersectNotFound{tip} / Done.
 *
 * LocalChainSync uses the same state machine as ChainSync but with mini
 * protocol id #5 and full blocks (not headers). The codec also pulls in
 * `ChainPoint` + `ChainTip` inner types — the round-trip tests exercise
 * both Origin + RealPoint variants.
 */
import { describe, it, expect } from "@effect/vitest";
import { Schema } from "effect";

import {
  LocalChainSyncMessage,
  LocalChainSyncMessageBytes,
  LocalChainSyncMessageType,
} from "../Schemas.ts";
import { ChainPointSchema, ChainPointType } from "../../types/ChainPoint.ts";
import type { ChainTip } from "../../types/ChainTip.ts";

const decodeBytes = Schema.decodeSync(LocalChainSyncMessageBytes);
const encodeBytes = Schema.encodeSync(LocalChainSyncMessageBytes);

const originPoint = ChainPointSchema.cases[ChainPointType.Origin].make({});
const realPoint = (slot: number, hashByte: number) =>
  ChainPointSchema.cases[ChainPointType.RealPoint].make({
    slot,
    hash: new Uint8Array(32).fill(hashByte),
  });

const originTip: ChainTip = { point: originPoint, blockNo: 0 };
const realTip = (slot: number, hashByte: number, blockNo: number): ChainTip => ({
  point: realPoint(slot, hashByte),
  blockNo,
});

describe("LocalChainSyncMessageBytes — wire-format codec", () => {
  describe("encode tag bytes (terminal cases)", () => {
    it("RequestNext → 0x81 0x00", () => {
      expect(
        encodeBytes(
          LocalChainSyncMessage.cases[LocalChainSyncMessageType.RequestNext].make({}),
        ).toHex(),
      ).toBe("8100");
    });

    it("AwaitReply → 0x81 0x01", () => {
      expect(
        encodeBytes(
          LocalChainSyncMessage.cases[LocalChainSyncMessageType.AwaitReply].make({}),
        ).toHex(),
      ).toBe("8101");
    });

    it("Done → 0x81 0x07", () => {
      expect(
        encodeBytes(
          LocalChainSyncMessage.cases[LocalChainSyncMessageType.Done].make({}),
        ).toHex(),
      ).toBe("8107");
    });
  });

  describe("decode (terminal cases)", () => {
    it("[0] → RequestNext", () => {
      expect(decodeBytes(Uint8Array.fromHex("8100"))._tag).toBe(
        LocalChainSyncMessageType.RequestNext,
      );
    });
    it("[1] → AwaitReply", () => {
      expect(decodeBytes(Uint8Array.fromHex("8101"))._tag).toBe(
        LocalChainSyncMessageType.AwaitReply,
      );
    });
    it("[7] → Done", () => {
      expect(decodeBytes(Uint8Array.fromHex("8107"))._tag).toBe(
        LocalChainSyncMessageType.Done,
      );
    });

    it("unknown tag throws", () => {
      // 0x81 0x08 — tag 8 not in dispatch.
      expect(() => decodeBytes(Uint8Array.fromHex("8108"))).toThrow();
    });
  });

  describe("round-trip stability", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      [
        "RequestNext",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.RequestNext].make({}),
      ],
      [
        "AwaitReply",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.AwaitReply].make({}),
      ],
      [
        "RollForward(empty block, origin tip)",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.RollForward].make({
          block: new Uint8Array(0),
          tip: originTip,
        }),
      ],
      [
        "RollForward(64-byte block, real tip)",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.RollForward].make({
          block: new Uint8Array(64).fill(0x42),
          tip: realTip(100, 0xaa, 50),
        }),
      ],
      [
        "RollBackward(origin point, origin tip)",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.RollBackward].make({
          point: originPoint,
          tip: originTip,
        }),
      ],
      [
        "RollBackward(real point, real tip)",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.RollBackward].make({
          point: realPoint(50, 0xbb),
          tip: realTip(100, 0xcc, 50),
        }),
      ],
      [
        "FindIntersect([])",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.FindIntersect].make({
          points: [],
        }),
      ],
      [
        "FindIntersect([origin])",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.FindIntersect].make({
          points: [originPoint],
        }),
      ],
      [
        "FindIntersect([real, real])",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.FindIntersect].make({
          points: [realPoint(100, 0xaa), realPoint(200, 0xbb)],
        }),
      ],
      [
        "IntersectFound(real, real)",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.IntersectFound].make({
          point: realPoint(100, 0xaa),
          tip: realTip(200, 0xbb, 100),
        }),
      ],
      [
        "IntersectNotFound(origin tip)",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.IntersectNotFound].make({
          tip: originTip,
        }),
      ],
      [
        "IntersectNotFound(real tip)",
        LocalChainSyncMessage.cases[LocalChainSyncMessageType.IntersectNotFound].make({
          tip: realTip(100, 0xaa, 50),
        }),
      ],
      ["Done", LocalChainSyncMessage.cases[LocalChainSyncMessageType.Done].make({})],
    ];

    for (const [name, msg] of cases) {
      it(`${name} round-trips byte-exactly`, () => {
        const bytes = encodeBytes(msg as never);
        const decoded = decodeBytes(bytes);
        expect(decoded).toEqual(msg);
      });
    }
  });
});
