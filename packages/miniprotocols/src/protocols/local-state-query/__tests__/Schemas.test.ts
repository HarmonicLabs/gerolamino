/**
 * Test-coverage gap #17 (continued) — LocalStateQuery wire-format codec.
 *
 * 8 messages: Acquire{point?} / Acquired / Failure / Query / Result /
 * ReAcquire{point?} / Release / Done. Wire format per
 * `Schemas.ts:84-92`.
 *
 * `Acquire` and `ReAcquire` carry an OPTIONAL `ChainPoint`, encoded as
 * CBOR `null` when absent (per `encodeOptionalChainPoint`). The
 * round-trip tests cover both branches.
 */
import { describe, it, expect } from "@effect/vitest";
import { Schema } from "effect";

import {
  LocalStateQueryMessage,
  LocalStateQueryMessageBytes,
  LocalStateQueryMessageType,
} from "../Schemas.ts";
import { ChainPointSchema, ChainPointType } from "../../types/ChainPoint.ts";

const decodeBytes = Schema.decodeSync(LocalStateQueryMessageBytes);
const encodeBytes = Schema.encodeSync(LocalStateQueryMessageBytes);

const realPoint = (slot: number, hashByte: number) =>
  ChainPointSchema.cases[ChainPointType.RealPoint].make({
    slot,
    hash: new Uint8Array(32).fill(hashByte),
  });

describe("LocalStateQueryMessageBytes — wire-format codec", () => {
  describe("encode", () => {
    it("Acquire(no point) → 0x82 0x00 0xf6", () => {
      const msg = LocalStateQueryMessage.cases[LocalStateQueryMessageType.Acquire].make({});
      // 0xf6 = CBOR major-7 simple-null.
      expect(encodeBytes(msg).toHex()).toBe("8200f6");
    });

    it("Acquired → 0x81 0x01", () => {
      expect(
        encodeBytes(
          LocalStateQueryMessage.cases[LocalStateQueryMessageType.Acquired].make({}),
        ).toHex(),
      ).toBe("8101");
    });

    it("Release → 0x81 0x06", () => {
      expect(
        encodeBytes(
          LocalStateQueryMessage.cases[LocalStateQueryMessageType.Release].make({}),
        ).toHex(),
      ).toBe("8106");
    });

    it("Done → 0x81 0x07", () => {
      expect(
        encodeBytes(
          LocalStateQueryMessage.cases[LocalStateQueryMessageType.Done].make({}),
        ).toHex(),
      ).toBe("8107");
    });

    it("Failure(2-byte) → 0x82 0x02 0x42 0xab 0xcd", () => {
      const msg = LocalStateQueryMessage.cases[LocalStateQueryMessageType.Failure].make({
        failure: new Uint8Array([0xab, 0xcd]),
      });
      expect(encodeBytes(msg).toHex()).toBe("820242abcd");
    });

    it("Query(2-byte) → 0x82 0x03 0x42 0x11 0x22", () => {
      const msg = LocalStateQueryMessage.cases[LocalStateQueryMessageType.Query].make({
        query: new Uint8Array([0x11, 0x22]),
      });
      expect(encodeBytes(msg).toHex()).toBe("82034211 22".replaceAll(" ", ""));
    });

    it("Result(2-byte) → 0x82 0x04 0x42 0x33 0x44", () => {
      const msg = LocalStateQueryMessage.cases[LocalStateQueryMessageType.Result].make({
        result: new Uint8Array([0x33, 0x44]),
      });
      expect(encodeBytes(msg).toHex()).toBe("8204423344");
    });
  });

  describe("decode", () => {
    it("[0, null] → Acquire (no point)", () => {
      const msg = decodeBytes(Uint8Array.fromHex("8200f6"));
      expect(msg._tag).toBe(LocalStateQueryMessageType.Acquire);
      if (msg._tag === LocalStateQueryMessageType.Acquire) {
        expect(msg.point).toBeUndefined();
      }
    });

    it("[1] → Acquired", () => {
      expect(decodeBytes(Uint8Array.fromHex("8101"))._tag).toBe(
        LocalStateQueryMessageType.Acquired,
      );
    });

    it("[6] → Release", () => {
      expect(decodeBytes(Uint8Array.fromHex("8106"))._tag).toBe(
        LocalStateQueryMessageType.Release,
      );
    });

    it("[7] → Done", () => {
      expect(decodeBytes(Uint8Array.fromHex("8107"))._tag).toBe(
        LocalStateQueryMessageType.Done,
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
        "Acquire(no point)",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.Acquire].make({}),
      ],
      [
        "Acquire(with real point)",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.Acquire].make({
          point: realPoint(100, 0xaa),
        }),
      ],
      [
        "Acquired",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.Acquired].make({}),
      ],
      [
        "Failure(empty)",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.Failure].make({
          failure: new Uint8Array(0),
        }),
      ],
      [
        "Failure(8 bytes)",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.Failure].make({
          failure: new Uint8Array(8).fill(0xff),
        }),
      ],
      [
        "Query(empty)",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.Query].make({
          query: new Uint8Array(0),
        }),
      ],
      [
        "Query(64 bytes)",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.Query].make({
          query: new Uint8Array(64).fill(0x42),
        }),
      ],
      [
        "Result(empty)",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.Result].make({
          result: new Uint8Array(0),
        }),
      ],
      [
        "Result(128 bytes)",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.Result].make({
          result: new Uint8Array(128).fill(0x55),
        }),
      ],
      [
        "ReAcquire(no point)",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.ReAcquire].make({}),
      ],
      [
        "ReAcquire(with real point)",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.ReAcquire].make({
          point: realPoint(200, 0xbb),
        }),
      ],
      [
        "Release",
        LocalStateQueryMessage.cases[LocalStateQueryMessageType.Release].make({}),
      ],
      ["Done", LocalStateQueryMessage.cases[LocalStateQueryMessageType.Done].make({})],
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
