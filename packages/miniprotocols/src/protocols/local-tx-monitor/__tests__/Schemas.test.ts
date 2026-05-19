/**
 * Test-coverage gap #17 (continued) — LocalTxMonitor wire-format codec.
 *
 * 10 messages: Acquire / Acquired{slot} / Release / NextTx /
 * ReplyNextTx{tx?} / HasTx{txId} / ReplyHasTx{hasTx} / GetSizes /
 * ReplyGetSizes{sizes} / Done. Wire format per `Schemas.ts:62-72`.
 *
 * Notable variants:
 * - `ReplyNextTx` has an OPTIONAL `tx` payload — encoder emits a
 *   1-element array when absent, 2-element when present.
 * - `ReplyHasTx` uses a CBOR Simple bool, not uint.
 * - `ReplyGetSizes` is a 4-element array (capacity, size, txCount).
 */
import { describe, it, expect } from "@effect/vitest";
import { Schema } from "effect";

import {
  LocalTxMonitorMessage,
  LocalTxMonitorMessageBytes,
  LocalTxMonitorMessageType,
} from "../Schemas.ts";

const decodeBytes = Schema.decodeSync(LocalTxMonitorMessageBytes);
const encodeBytes = Schema.encodeSync(LocalTxMonitorMessageBytes);

describe("LocalTxMonitorMessageBytes — wire-format codec", () => {
  describe("encode", () => {
    it("Acquire → 0x81 0x00", () => {
      const msg = LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.Acquire].make({});
      expect(encodeBytes(msg).toHex()).toBe("8100");
    });

    it("Acquired(slot=42) → 0x82 0x01 0x18 0x2a", () => {
      const msg = LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.Acquired].make({
        slot: 42,
      });
      expect(encodeBytes(msg).toHex()).toBe("8201182a");
    });

    it("Release → 0x81 0x02", () => {
      expect(
        encodeBytes(
          LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.Release].make({}),
        ).toHex(),
      ).toBe("8102");
    });

    it("NextTx → 0x81 0x03", () => {
      expect(
        encodeBytes(
          LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.NextTx].make({}),
        ).toHex(),
      ).toBe("8103");
    });

    it("ReplyNextTx (no tx) → 0x81 0x04", () => {
      const msg = LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.ReplyNextTx].make({});
      expect(encodeBytes(msg).toHex()).toBe("8104");
    });

    it("ReplyNextTx (2-byte tx) → 0x82 0x04 0x42 0xab 0xcd", () => {
      const msg = LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.ReplyNextTx].make({
        tx: new Uint8Array([0xab, 0xcd]),
      });
      expect(encodeBytes(msg).toHex()).toBe("820442abcd");
    });

    it("HasTx(2-byte id) → 0x82 0x05 0x42 0xff 0x00", () => {
      const msg = LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.HasTx].make({
        txId: new Uint8Array([0xff, 0x00]),
      });
      expect(encodeBytes(msg).toHex()).toBe("820542ff00");
    });

    it("ReplyHasTx(true) → 0x82 0x06 0xf5", () => {
      const msg = LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.ReplyHasTx].make({
        hasTx: true,
      });
      // 0xf5 = CBOR major-7 simple-true.
      expect(encodeBytes(msg).toHex()).toBe("8206f5");
    });

    it("ReplyHasTx(false) → 0x82 0x06 0xf4", () => {
      const msg = LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.ReplyHasTx].make({
        hasTx: false,
      });
      // 0xf4 = simple-false.
      expect(encodeBytes(msg).toHex()).toBe("8206f4");
    });

    it("GetSizes → 0x81 0x07", () => {
      expect(
        encodeBytes(
          LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.GetSizes].make({}),
        ).toHex(),
      ).toBe("8107");
    });

    it("ReplyGetSizes — 4-element array (tag + 3 numerics)", () => {
      const msg = LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.ReplyGetSizes].make({
        sizes: { capacity: 100, size: 50, txCount: 5 },
      });
      // 0x84 = array(4); 0x08 = uint(8); 0x18 0x64 = uint(100);
      // 0x18 0x32 = uint(50); 0x05 = uint(5).
      expect(encodeBytes(msg).toHex()).toBe("840818641832 05".replaceAll(" ", ""));
    });

    it("Done → 0x81 0x09", () => {
      expect(
        encodeBytes(
          LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.Done].make({}),
        ).toHex(),
      ).toBe("8109");
    });
  });

  describe("decode", () => {
    it("[0] → Acquire", () => {
      expect(decodeBytes(Uint8Array.fromHex("8100"))._tag).toBe(
        LocalTxMonitorMessageType.Acquire,
      );
    });

    it("[1, slot] → Acquired", () => {
      const msg = decodeBytes(Uint8Array.fromHex("8201182a"));
      expect(msg._tag).toBe(LocalTxMonitorMessageType.Acquired);
      if (msg._tag === LocalTxMonitorMessageType.Acquired) {
        expect(msg.slot).toBe(42);
      }
    });

    it("[4] → ReplyNextTx (tx absent)", () => {
      const msg = decodeBytes(Uint8Array.fromHex("8104"));
      expect(msg._tag).toBe(LocalTxMonitorMessageType.ReplyNextTx);
      if (msg._tag === LocalTxMonitorMessageType.ReplyNextTx) {
        expect(msg.tx).toBeUndefined();
      }
    });

    it("[4, bytes] → ReplyNextTx (tx present)", () => {
      const msg = decodeBytes(Uint8Array.fromHex("820442abcd"));
      expect(msg._tag).toBe(LocalTxMonitorMessageType.ReplyNextTx);
      if (msg._tag === LocalTxMonitorMessageType.ReplyNextTx) {
        expect(msg.tx).toEqual(new Uint8Array([0xab, 0xcd]));
      }
    });

    it("[6, true] → ReplyHasTx(true)", () => {
      const msg = decodeBytes(Uint8Array.fromHex("8206f5"));
      expect(msg._tag).toBe(LocalTxMonitorMessageType.ReplyHasTx);
      if (msg._tag === LocalTxMonitorMessageType.ReplyHasTx) {
        expect(msg.hasTx).toBe(true);
      }
    });

    it("[8, capacity, size, count] → ReplyGetSizes", () => {
      const msg = decodeBytes(Uint8Array.fromHex("8408186418320 5".replaceAll(" ", "")));
      expect(msg._tag).toBe(LocalTxMonitorMessageType.ReplyGetSizes);
      if (msg._tag === LocalTxMonitorMessageType.ReplyGetSizes) {
        expect(msg.sizes).toEqual({ capacity: 100, size: 50, txCount: 5 });
      }
    });

    // Decoder's `default:` arm at Schemas.ts:115 maps unknown tags to
    // Done — same convention as keep-alive + peer-sharing.
    it("unknown tag falls through to Done", () => {
      // 0x81 0x0c — tag 12.
      const msg = decodeBytes(Uint8Array.fromHex("810c"));
      expect(msg._tag).toBe(LocalTxMonitorMessageType.Done);
    });
  });

  describe("round-trip stability", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["Acquire", LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.Acquire].make({})],
      [
        "Acquired(0)",
        LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.Acquired].make({ slot: 0 }),
      ],
      [
        "Acquired(big)",
        LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.Acquired].make({
          slot: 100_000_000,
        }),
      ],
      ["Release", LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.Release].make({})],
      ["NextTx", LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.NextTx].make({})],
      [
        "ReplyNextTx(absent)",
        LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.ReplyNextTx].make({}),
      ],
      [
        "ReplyNextTx(present)",
        LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.ReplyNextTx].make({
          tx: new Uint8Array(64).fill(0x42),
        }),
      ],
      [
        "HasTx",
        LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.HasTx].make({
          txId: new Uint8Array(32).fill(0xab),
        }),
      ],
      [
        "ReplyHasTx(true)",
        LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.ReplyHasTx].make({
          hasTx: true,
        }),
      ],
      [
        "ReplyHasTx(false)",
        LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.ReplyHasTx].make({
          hasTx: false,
        }),
      ],
      [
        "GetSizes",
        LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.GetSizes].make({}),
      ],
      [
        "ReplyGetSizes(0,0,0)",
        LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.ReplyGetSizes].make({
          sizes: { capacity: 0, size: 0, txCount: 0 },
        }),
      ],
      [
        "ReplyGetSizes(big numbers)",
        LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.ReplyGetSizes].make({
          sizes: { capacity: 1_000_000, size: 65536, txCount: 4096 },
        }),
      ],
      ["Done", LocalTxMonitorMessage.cases[LocalTxMonitorMessageType.Done].make({})],
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
