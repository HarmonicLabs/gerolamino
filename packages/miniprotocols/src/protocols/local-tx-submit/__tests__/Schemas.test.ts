/**
 * Test-coverage gap #17 (continued) — LocalTxSubmit wire-format codec.
 *
 * 4 messages: `SubmitTx {tx}`, `AcceptTx`, `RejectTx {reason}`, `Done`.
 * Wire format: `[0,tx] / [1] / [2,reason] / [3]`. Pin every dispatch
 * value byte-exactly so a `cborSyncCodec` evolution surfaces here at
 * the codec boundary.
 */
import { describe, it, expect } from "@effect/vitest";
import { Schema } from "effect";

import {
  LocalTxSubmitMessage,
  LocalTxSubmitMessageBytes,
  LocalTxSubmitMessageType,
} from "../Schemas.ts";

const decodeBytes = Schema.decodeSync(LocalTxSubmitMessageBytes);
const encodeBytes = Schema.encodeSync(LocalTxSubmitMessageBytes);

describe("LocalTxSubmitMessageBytes — wire-format codec", () => {
  describe("encode", () => {
    it("SubmitTx(2-byte payload) → 0x82 0x00 0x42 0xab 0xcd", () => {
      const msg = LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.SubmitTx].make({
        tx: new Uint8Array([0xab, 0xcd]),
      });
      expect(encodeBytes(msg).toHex()).toBe("820042abcd");
    });

    it("AcceptTx → 0x81 0x01", () => {
      const msg = LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.AcceptTx].make({});
      expect(encodeBytes(msg).toHex()).toBe("8101");
    });

    it("RejectTx(2-byte reason) → 0x82 0x02 0x42 0xff 0xee", () => {
      const msg = LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.RejectTx].make({
        reason: new Uint8Array([0xff, 0xee]),
      });
      expect(encodeBytes(msg).toHex()).toBe("820242ffee");
    });

    it("Done → 0x81 0x03", () => {
      const msg = LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.Done].make({});
      expect(encodeBytes(msg).toHex()).toBe("8103");
    });
  });

  describe("decode", () => {
    it("[0, bytes] → SubmitTx", () => {
      const msg = decodeBytes(Uint8Array.fromHex("820042abcd"));
      expect(msg._tag).toBe(LocalTxSubmitMessageType.SubmitTx);
      if (msg._tag === LocalTxSubmitMessageType.SubmitTx) {
        expect(msg.tx).toEqual(new Uint8Array([0xab, 0xcd]));
      }
    });

    it("[1] → AcceptTx", () => {
      expect(decodeBytes(Uint8Array.fromHex("8101"))._tag).toBe(
        LocalTxSubmitMessageType.AcceptTx,
      );
    });

    it("[2, bytes] → RejectTx", () => {
      const msg = decodeBytes(Uint8Array.fromHex("820242ffee"));
      expect(msg._tag).toBe(LocalTxSubmitMessageType.RejectTx);
      if (msg._tag === LocalTxSubmitMessageType.RejectTx) {
        expect(msg.reason).toEqual(new Uint8Array([0xff, 0xee]));
      }
    });

    it("[3] → Done", () => {
      expect(decodeBytes(Uint8Array.fromHex("8103"))._tag).toBe(
        LocalTxSubmitMessageType.Done,
      );
    });

    it("unknown tag throws", () => {
      // 0x81 0x05 — tag 5 not in dispatch.
      expect(() => decodeBytes(Uint8Array.fromHex("8105"))).toThrow();
    });

    it("SubmitTx without bytes throws", () => {
      // 0x81 0x00 — array(1) [uint 0]; missing tx payload.
      expect(() => decodeBytes(Uint8Array.fromHex("8100"))).toThrow();
    });
  });

  describe("round-trip stability", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      [
        "SubmitTx(empty)",
        LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.SubmitTx].make({
          tx: new Uint8Array(0),
        }),
      ],
      [
        "SubmitTx(64 bytes)",
        LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.SubmitTx].make({
          tx: new Uint8Array(64).fill(0x42),
        }),
      ],
      [
        "AcceptTx",
        LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.AcceptTx].make({}),
      ],
      [
        "RejectTx(empty reason)",
        LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.RejectTx].make({
          reason: new Uint8Array(0),
        }),
      ],
      [
        "RejectTx(32 bytes)",
        LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.RejectTx].make({
          reason: new Uint8Array(32).fill(0xee),
        }),
      ],
      [
        "Done",
        LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.Done].make({}),
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
});
