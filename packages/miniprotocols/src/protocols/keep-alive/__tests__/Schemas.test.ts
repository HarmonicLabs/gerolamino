/**
 * Test-coverage gap #17 (partial) — KeepAlive wire-format codec.
 *
 * The keep-alive protocol exchanges three CBOR messages
 * (`KeepAlive {cookie}`, `KeepAliveResponse {cookie}`, `Done`) per
 * Ouroboros §4.4. The wire format is `[0,c]` / `[1,c]` / `[2]` over
 * CBOR. A regression in the encode/decode arms of `KeepAliveMessageBytes`
 * would silently corrupt every keep-alive RTT measurement (cookies
 * mismatch → `KeepAliveCookieMissmatch` raised at every round trip).
 *
 * These tests pin the wire format byte-exactly so a future
 * `cborSyncCodec` evolution that re-orders array elements or changes
 * the tag values surfaces here at the codec boundary instead of in
 * production.
 */
import { describe, it, expect } from "@effect/vitest";
import { Schema } from "effect";

import {
  KeepAliveMessage,
  KeepAliveMessageBytes,
  KeepAliveMessageType,
} from "../Schemas.ts";

const decodeBytes = Schema.decodeSync(KeepAliveMessageBytes);
const encodeBytes = Schema.encodeSync(KeepAliveMessageBytes);

describe("KeepAliveMessageBytes — wire-format codec", () => {
  describe("encode", () => {
    it("KeepAlive(cookie=0) → CBOR [0, 0] = 0x82 0x00 0x00", () => {
      const msg = KeepAliveMessage.cases[KeepAliveMessageType.KeepAlive].make({
        cookie: 0,
      });
      const bytes = encodeBytes(msg);
      expect(bytes.toHex()).toBe("820000");
    });

    it("KeepAlive(cookie=42) → CBOR [0, 42]", () => {
      const msg = KeepAliveMessage.cases[KeepAliveMessageType.KeepAlive].make({
        cookie: 42,
      });
      const bytes = encodeBytes(msg);
      // 0x82 = array(2); 0x00 = uint(0); 0x18 0x2a = uint(42, 1-byte).
      expect(bytes.toHex()).toBe("820018 2a".replaceAll(" ", ""));
    });

    it("KeepAlive(cookie=65535 = max word16) → 2-byte uint encoding", () => {
      const msg = KeepAliveMessage.cases[KeepAliveMessageType.KeepAlive].make({
        cookie: 65535,
      });
      const bytes = encodeBytes(msg);
      // 0x82 = array(2); 0x00 = uint(0); 0x19 0xff 0xff = uint(65535, 2-byte).
      expect(bytes.toHex()).toBe("820019ffff");
    });

    it("KeepAliveResponse(cookie=42) → CBOR [1, 42]", () => {
      const msg = KeepAliveMessage.cases[KeepAliveMessageType.KeepAliveResponse].make({
        cookie: 42,
      });
      const bytes = encodeBytes(msg);
      // 0x82 = array(2); 0x01 = uint(1); 0x18 0x2a = uint(42, 1-byte).
      expect(bytes.toHex()).toBe("8201182a");
    });

    it("Done → CBOR [2] = 0x81 0x02", () => {
      const msg = KeepAliveMessage.cases[KeepAliveMessageType.Done].make({});
      const bytes = encodeBytes(msg);
      expect(bytes.toHex()).toBe("8102");
    });
  });

  describe("decode", () => {
    it("CBOR [0, 0] → KeepAlive(cookie=0)", () => {
      const msg = decodeBytes(Uint8Array.fromHex("820000"));
      expect(msg._tag).toBe(KeepAliveMessageType.KeepAlive);
      if (msg._tag === KeepAliveMessageType.KeepAlive) {
        expect(msg.cookie).toBe(0);
      }
    });

    it("CBOR [0, 42] → KeepAlive(cookie=42)", () => {
      const msg = decodeBytes(Uint8Array.fromHex("8200182a"));
      expect(msg._tag).toBe(KeepAliveMessageType.KeepAlive);
      if (msg._tag === KeepAliveMessageType.KeepAlive) {
        expect(msg.cookie).toBe(42);
      }
    });

    it("CBOR [1, 65535] → KeepAliveResponse(cookie=65535)", () => {
      const msg = decodeBytes(Uint8Array.fromHex("820119ffff"));
      expect(msg._tag).toBe(KeepAliveMessageType.KeepAliveResponse);
      if (msg._tag === KeepAliveMessageType.KeepAliveResponse) {
        expect(msg.cookie).toBe(65535);
      }
    });

    it("CBOR [2] → Done", () => {
      const msg = decodeBytes(Uint8Array.fromHex("8102"));
      expect(msg._tag).toBe(KeepAliveMessageType.Done);
    });

    // Per `Schemas.ts:48`, the `default:` arm of the parser falls through
    // to Done — any unrecognised tag at index 0 maps to Done.
    it("unknown tag falls through to Done (per parser default arm)", () => {
      // 0x81 0x05 = array(1) [uint(5)] — tag 5 isn't recognised.
      const msg = decodeBytes(Uint8Array.fromHex("8105"));
      expect(msg._tag).toBe(KeepAliveMessageType.Done);
    });
  });

  describe("round-trip stability", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      [
        "KeepAlive(0)",
        KeepAliveMessage.cases[KeepAliveMessageType.KeepAlive].make({ cookie: 0 }),
      ],
      [
        "KeepAlive(1)",
        KeepAliveMessage.cases[KeepAliveMessageType.KeepAlive].make({ cookie: 1 }),
      ],
      [
        "KeepAlive(255)",
        KeepAliveMessage.cases[KeepAliveMessageType.KeepAlive].make({ cookie: 255 }),
      ],
      [
        "KeepAlive(65535)",
        KeepAliveMessage.cases[KeepAliveMessageType.KeepAlive].make({ cookie: 65535 }),
      ],
      [
        "KeepAliveResponse(0)",
        KeepAliveMessage.cases[KeepAliveMessageType.KeepAliveResponse].make({
          cookie: 0,
        }),
      ],
      [
        "KeepAliveResponse(65535)",
        KeepAliveMessage.cases[KeepAliveMessageType.KeepAliveResponse].make({
          cookie: 65535,
        }),
      ],
      ["Done", KeepAliveMessage.cases[KeepAliveMessageType.Done].make({})],
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
