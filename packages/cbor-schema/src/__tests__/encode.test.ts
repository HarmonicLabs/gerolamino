import { it, describe, expect } from "@effect/vitest";
import { encodeSync, CborKinds, type CborSchemaType } from "../index";

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

describe("encodeSync", () => {
  describe("unsigned integers", () => {
    it("0", () => expect(toHex(encodeSync({ _tag: CborKinds.UInt, num: 0n }))).toBe("00"));
    it("1", () => expect(toHex(encodeSync({ _tag: CborKinds.UInt, num: 1n }))).toBe("01"));
    it("MAX_SAFE_INTEGER", () =>
      expect(toHex(encodeSync({ _tag: CborKinds.UInt, num: BigInt(Number.MAX_SAFE_INTEGER) }))).toBe(
        "1b001fffffffffffff",
      ));
  });

  describe("negative integers", () => {
    it("-1", () => expect(toHex(encodeSync({ _tag: CborKinds.NegInt, num: -1n }))).toBe("20"));
    it("-5", () => expect(toHex(encodeSync({ _tag: CborKinds.NegInt, num: -5n }))).toBe("24"));
    it("-MAX_SAFE_INTEGER", () =>
      expect(toHex(encodeSync({ _tag: CborKinds.NegInt, num: -BigInt(Number.MAX_SAFE_INTEGER) }))).toBe(
        "3b001ffffffffffffe",
      ));
  });

  describe("text strings", () => {
    it("ciaone", () =>
      expect(toHex(encodeSync({ _tag: CborKinds.Text, text: "ciaone" }))).toBe("666369616f6e65"));
  });

  describe("byte strings", () => {
    it("ciaone as bytes", () => {
      const bytes = new TextEncoder().encode("ciaone");
      expect(toHex(encodeSync({ _tag: CborKinds.Bytes, bytes }))).toBe("466369616f6e65");
    });
  });

  describe("arrays", () => {
    it("[1, 2, 3]", () =>
      expect(
        toHex(
          encodeSync({
            _tag: CborKinds.Array,
            items: [
              { _tag: CborKinds.UInt, num: 1n },
              { _tag: CborKinds.UInt, num: 2n },
              { _tag: CborKinds.UInt, num: 3n },
            ],
          }),
        ),
      ).toBe("83010203"));
  });

  describe("maps", () => {
    it("{bytes: text, uint: array}", () =>
      expect(
        toHex(
          encodeSync({
            _tag: CborKinds.Map,
            entries: [
              {
                k: { _tag: CborKinds.Bytes, bytes: new TextEncoder().encode("ciaone") },
                v: { _tag: CborKinds.Text, text: "mondone" },
              },
              {
                k: { _tag: CborKinds.UInt, num: 1n },
                v: {
                  _tag: CborKinds.Array,
                  items: [
                    { _tag: CborKinds.UInt, num: 2n },
                    { _tag: CborKinds.UInt, num: 3n },
                  ],
                },
              },
            ],
          }),
        ),
      ).toBe("a2466369616f6e65676d6f6e646f6e6501820203"));
  });

  describe("tags", () => {
    it("tag 6 wrapping empty array", () =>
      expect(
        toHex(encodeSync({ _tag: CborKinds.Tag, tag: 6n, data: { _tag: CborKinds.Array, items: [] } })),
      ).toBe("c680"));

    it("tag 6 wrapping uint 2", () =>
      expect(
        toHex(encodeSync({ _tag: CborKinds.Tag, tag: 6n, data: { _tag: CborKinds.UInt, num: 2n } })),
      ).toBe("c602"));
  });
});
