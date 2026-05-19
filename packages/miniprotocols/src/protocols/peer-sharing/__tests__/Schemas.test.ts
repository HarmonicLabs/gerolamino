/**
 * Test-coverage gap #17 (continued) — PeerSharing wire-format codec.
 *
 * 3 messages: `ShareRequest {amount}`, `SharePeers {peers}`, `Done`.
 * Plus the inner `PeerAddress` codec with IPv4 + IPv6 variants. Wire
 * format per `Schemas.ts:88-91`.
 */
import { describe, it, expect } from "@effect/vitest";
import { Schema } from "effect";

import {
  PeerAddressSchema,
  PeerAddressType,
  PeerSharingMessage,
  PeerSharingMessageBytes,
  PeerSharingMessageType,
} from "../Schemas.ts";

const decodeBytes = Schema.decodeSync(PeerSharingMessageBytes);
const encodeBytes = Schema.encodeSync(PeerSharingMessageBytes);

const ipv4 = (a: number, b: number, c: number, d: number, port: number) =>
  PeerAddressSchema.cases[PeerAddressType.IPv4].make({
    addr: new Uint8Array([a, b, c, d]),
    port,
  });

const ipv6 = (port: number) =>
  PeerAddressSchema.cases[PeerAddressType.IPv6].make({
    addr: new Uint8Array(16).fill(0xab),
    port,
  });

describe("PeerSharingMessageBytes — wire-format codec", () => {
  describe("encode", () => {
    it("ShareRequest(5) → 0x82 0x00 0x05", () => {
      const msg = PeerSharingMessage.cases[PeerSharingMessageType.ShareRequest].make({
        amount: 5,
      });
      expect(encodeBytes(msg).toHex()).toBe("820005");
    });

    it("Done → 0x81 0x02", () => {
      const msg = PeerSharingMessage.cases[PeerSharingMessageType.Done].make({});
      expect(encodeBytes(msg).toHex()).toBe("8102");
    });

    it("SharePeers([]) → 0x82 0x01 0x80", () => {
      const msg = PeerSharingMessage.cases[PeerSharingMessageType.SharePeers].make({
        peers: [],
      });
      expect(encodeBytes(msg).toHex()).toBe("820180");
    });

    it("SharePeers([IPv4]) — outer + inner array shape", () => {
      const msg = PeerSharingMessage.cases[PeerSharingMessageType.SharePeers].make({
        peers: [ipv4(127, 0, 0, 1, 3001)],
      });
      const bytes = encodeBytes(msg);
      // 0x82 array(2); 0x01 tag(1); 0x81 array(1); 0x83 array(3);
      // 0x00 IPv4 tag; 0x44 bytes(4); 7f 00 00 01 IP; 0x19 0x0b 0xb9 port=3001.
      expect(bytes.toHex()).toBe("8201818300447f000001190bb9");
    });
  });

  describe("decode", () => {
    it("[0, amount] → ShareRequest", () => {
      const msg = decodeBytes(Uint8Array.fromHex("820005"));
      expect(msg._tag).toBe(PeerSharingMessageType.ShareRequest);
      if (msg._tag === PeerSharingMessageType.ShareRequest) {
        expect(msg.amount).toBe(5);
      }
    });

    it("[1, []] → SharePeers (empty)", () => {
      const msg = decodeBytes(Uint8Array.fromHex("820180"));
      expect(msg._tag).toBe(PeerSharingMessageType.SharePeers);
      if (msg._tag === PeerSharingMessageType.SharePeers) {
        expect(msg.peers).toHaveLength(0);
      }
    });

    it("[2] → Done", () => {
      expect(decodeBytes(Uint8Array.fromHex("8102"))._tag).toBe(
        PeerSharingMessageType.Done,
      );
    });

    // The decoder's `default:` arm at Schemas.ts:111 maps any other tag
    // to Done — same convention as keep-alive. Pin it.
    it("unknown tag falls through to Done (per parser default arm)", () => {
      // 0x81 0x05 — tag 5 not in the explicit dispatch.
      const msg = decodeBytes(Uint8Array.fromHex("8105"));
      expect(msg._tag).toBe(PeerSharingMessageType.Done);
    });
  });

  describe("round-trip stability", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      [
        "ShareRequest(0)",
        PeerSharingMessage.cases[PeerSharingMessageType.ShareRequest].make({
          amount: 0,
        }),
      ],
      [
        "ShareRequest(255)",
        PeerSharingMessage.cases[PeerSharingMessageType.ShareRequest].make({
          amount: 255,
        }),
      ],
      [
        "SharePeers([])",
        PeerSharingMessage.cases[PeerSharingMessageType.SharePeers].make({
          peers: [],
        }),
      ],
      [
        "SharePeers([IPv4])",
        PeerSharingMessage.cases[PeerSharingMessageType.SharePeers].make({
          peers: [ipv4(127, 0, 0, 1, 3001)],
        }),
      ],
      [
        "SharePeers([IPv4, IPv4])",
        PeerSharingMessage.cases[PeerSharingMessageType.SharePeers].make({
          peers: [ipv4(127, 0, 0, 1, 3001), ipv4(192, 168, 1, 1, 3000)],
        }),
      ],
      [
        "SharePeers([IPv6])",
        PeerSharingMessage.cases[PeerSharingMessageType.SharePeers].make({
          peers: [ipv6(3001)],
        }),
      ],
      [
        "SharePeers([IPv4, IPv6])",
        PeerSharingMessage.cases[PeerSharingMessageType.SharePeers].make({
          peers: [ipv4(10, 0, 0, 1, 3001), ipv6(3001)],
        }),
      ],
      [
        "Done",
        PeerSharingMessage.cases[PeerSharingMessageType.Done].make({}),
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
