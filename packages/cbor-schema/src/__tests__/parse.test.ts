import { it, describe, expect } from "@effect/vitest";
import { BigDecimal } from "effect";
import { parseSync, CborKinds } from "../index";

const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return bytes;
};

describe("parseSync", () => {
  describe("unsigned integers", () => {
    it("inline (0-23)", () => {
      expect(parseSync(fromHex("00"))).toMatchObject({ _tag: CborKinds.UInt, num: 0n });
      expect(parseSync(fromHex("01"))).toMatchObject({ _tag: CborKinds.UInt, num: 1n });
      expect(parseSync(fromHex("0a"))).toMatchObject({ _tag: CborKinds.UInt, num: 10n });
      expect(parseSync(fromHex("17"))).toMatchObject({ _tag: CborKinds.UInt, num: 23n });
    });

    it("1-byte (24-255)", () => {
      expect(parseSync(fromHex("1818"))).toMatchObject({ _tag: CborKinds.UInt, num: 24n });
      expect(parseSync(fromHex("18ff"))).toMatchObject({ _tag: CborKinds.UInt, num: 255n });
    });

    it("2-byte", () => {
      expect(parseSync(fromHex("190100"))).toMatchObject({ _tag: CborKinds.UInt, num: 256n });
      expect(parseSync(fromHex("19ffff"))).toMatchObject({ _tag: CborKinds.UInt, num: 65535n });
    });

    it("4-byte", () => {
      expect(parseSync(fromHex("1a00010000"))).toMatchObject({ _tag: CborKinds.UInt, num: 65536n });
      expect(parseSync(fromHex("1affffffff"))).toMatchObject({ _tag: CborKinds.UInt, num: 4294967295n });
    });

    it("8-byte", () => {
      expect(parseSync(fromHex("1b001fffffffffffff"))).toMatchObject({
        _tag: CborKinds.UInt,
        num: BigInt(Number.MAX_SAFE_INTEGER),
      });
    });

    it("preserves addInfos", () => {
      const result = parseSync(fromHex("1801"));
      expect(result).toMatchObject({ _tag: CborKinds.UInt, num: 1n, addInfos: 24 });
    });
  });

  describe("negative integers", () => {
    it("inline", () => {
      expect(parseSync(fromHex("20"))).toMatchObject({ _tag: CborKinds.NegInt, num: -1n });
      expect(parseSync(fromHex("24"))).toMatchObject({ _tag: CborKinds.NegInt, num: -5n });
      expect(parseSync(fromHex("37"))).toMatchObject({ _tag: CborKinds.NegInt, num: -24n });
    });

    it("1-byte", () => {
      expect(parseSync(fromHex("3818"))).toMatchObject({ _tag: CborKinds.NegInt, num: -25n });
      expect(parseSync(fromHex("38ff"))).toMatchObject({ _tag: CborKinds.NegInt, num: -256n });
    });

    it("8-byte", () => {
      expect(parseSync(fromHex("3b001ffffffffffffe"))).toMatchObject({
        _tag: CborKinds.NegInt,
        num: -BigInt(Number.MAX_SAFE_INTEGER),
      });
    });
  });

  describe("byte strings", () => {
    it("empty bytes", () => {
      const result = parseSync(fromHex("40"));
      expect(result._tag).toBe(CborKinds.Bytes);
      if (result._tag === CborKinds.Bytes) {
        expect(result.bytes).toEqual(new Uint8Array(0));
        expect(result.addInfos).toBe(0);
      }
    });

    it("non-canonical empty bytes (1-byte length)", () => {
      const result = parseSync(fromHex("5800"));
      expect(result._tag).toBe(CborKinds.Bytes);
      if (result._tag === CborKinds.Bytes) {
        expect(result.bytes).toEqual(new Uint8Array(0));
        expect(result.addInfos).toBe(24);
      }
    });

    it("non-canonical empty bytes (2-byte length)", () => {
      const result = parseSync(fromHex("590000"));
      expect(result._tag).toBe(CborKinds.Bytes);
      if (result._tag === CborKinds.Bytes) {
        expect(result.bytes).toEqual(new Uint8Array(0));
        expect(result.addInfos).toBe(25);
      }
    });

    it("6 bytes", () => {
      const result = parseSync(fromHex("4601070a0f1418"));
      expect(result._tag).toBe(CborKinds.Bytes);
      if (result._tag === CborKinds.Bytes) {
        expect(result.bytes).toEqual(new Uint8Array([0x01, 0x07, 0x0a, 0x0f, 0x14, 0x18]));
      }
    });

    it("indefinite empty with break", () => {
      const result = parseSync(fromHex("5fff"));
      expect(result._tag).toBe(CborKinds.Bytes);
      if (result._tag === CborKinds.Bytes) {
        expect(result.bytes).toEqual(new Uint8Array(0));
        expect(result.addInfos).toBe(31);
        expect(result.chunks).toEqual([]);
      }
    });

    it("indefinite one empty chunk", () => {
      const result = parseSync(fromHex("5f40ff"));
      expect(result._tag).toBe(CborKinds.Bytes);
      if (result._tag === CborKinds.Bytes) {
        expect(result.bytes).toEqual(new Uint8Array(0));
        expect(result.addInfos).toBe(31);
        expect(result.chunks).toHaveLength(1);
      }
    });

    it("indefinite with data", () => {
      // Indefinite bytes: chunk [01,07,0a,0f,14,18] + chunk [01,07,0a,0f,14,18] + chunk [01,07,0a,0f,14,18]
      const result = parseSync(fromHex("5f4601070a0f14184601070a0f14184601070a0f1418ff"));
      expect(result._tag).toBe(CborKinds.Bytes);
      if (result._tag === CborKinds.Bytes) {
        expect(result.chunks).toHaveLength(3);
        expect(result.bytes.length).toBe(18);
      }
    });

    it("nested indefinite", () => {
      const result = parseSync(fromHex("5f5fffff"));
      expect(result._tag).toBe(CborKinds.Bytes);
      if (result._tag === CborKinds.Bytes) {
        expect(result.bytes).toEqual(new Uint8Array(0));
        expect(result.chunks).toHaveLength(1);
      }
    });
  });

  describe("text strings", () => {
    it("empty", () => {
      expect(parseSync(fromHex("60"))).toMatchObject({ _tag: CborKinds.Text, text: "" });
    });

    it("ciaone", () => {
      expect(parseSync(fromHex("666369616f6e65"))).toMatchObject({ _tag: CborKinds.Text, text: "ciaone" });
    });

    it("hello world", () => {
      expect(parseSync(fromHex("6b68656c6c6f20776f726c64"))).toMatchObject({ _tag: CborKinds.Text, text: "hello world" });
    });
  });

  describe("arrays", () => {
    it("empty", () => {
      expect(parseSync(fromHex("80"))).toMatchObject({ _tag: CborKinds.Array, items: [] });
    });

    it("[1, 2, 3]", () => {
      const result = parseSync(fromHex("83010203"));
      expect(result._tag).toBe(CborKinds.Array);
      if (result._tag === CborKinds.Array) {
        expect(result.items).toHaveLength(3);
        expect(result.items[0]).toMatchObject({ _tag: CborKinds.UInt, num: 1n });
        expect(result.items[1]).toMatchObject({ _tag: CborKinds.UInt, num: 2n });
        expect(result.items[2]).toMatchObject({ _tag: CborKinds.UInt, num: 3n });
      }
    });

    it("indefinite array", () => {
      const result = parseSync(fromHex("9f010203ff"));
      expect(result._tag).toBe(CborKinds.Array);
      if (result._tag === CborKinds.Array) {
        expect(result.items).toHaveLength(3);
        expect(result.addInfos).toBe(31);
      }
    });
  });

  describe("maps", () => {
    it("empty", () => {
      expect(parseSync(fromHex("a0"))).toMatchObject({ _tag: CborKinds.Map, entries: [] });
    });

    it("{bytes: text, uint: array}", () => {
      const result = parseSync(fromHex("a2466369616f6e65676d6f6e646f6e6501820203"));
      expect(result._tag).toBe(CborKinds.Map);
      if (result._tag === CborKinds.Map) {
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]!.k._tag).toBe(CborKinds.Bytes);
        expect(result.entries[0]!.v._tag).toBe(CborKinds.Text);
        expect(result.entries[1]!.k._tag).toBe(CborKinds.UInt);
        expect(result.entries[1]!.v._tag).toBe(CborKinds.Array);
      }
    });
  });

  describe("tags", () => {
    it("tag 6 wrapping empty array", () => {
      const result = parseSync(fromHex("c680"));
      expect(result._tag).toBe(CborKinds.Tag);
      if (result._tag === CborKinds.Tag) {
        expect(result.tag).toBe(6n);
        expect(result.data._tag).toBe(CborKinds.Array);
      }
    });

    it("bignum auto-promotion (tag 2)", () => {
      const result = parseSync(fromHex("c24101"));
      expect(result._tag).toBe(CborKinds.UInt);
      if (result._tag === CborKinds.UInt) expect(result.num).toBe(1n);
    });

    it("negative bignum auto-promotion (tag 3)", () => {
      const result = parseSync(fromHex("c34101"));
      expect(result._tag).toBe(CborKinds.NegInt);
      if (result._tag === CborKinds.NegInt) expect(result.num).toBe(-2n);
    });

    it("bignum empty bytes (value 0)", () => {
      const result = parseSync(fromHex("c240"));
      expect(result._tag).toBe(CborKinds.UInt);
      if (result._tag === CborKinds.UInt) expect(result.num).toBe(0n);
    });
  });

  describe("simple values", () => {
    it("false", () => expect(parseSync(fromHex("f4"))).toMatchObject({ _tag: CborKinds.Simple, value: false }));
    it("true", () => expect(parseSync(fromHex("f5"))).toMatchObject({ _tag: CborKinds.Simple, value: true }));
    it("null", () => expect(parseSync(fromHex("f6"))).toMatchObject({ _tag: CborKinds.Simple, value: null }));
    it("undefined", () => expect(parseSync(fromHex("f7"))).toMatchObject({ _tag: CborKinds.Simple, value: undefined }));
  });

  describe("floats", () => {
    it("float64: 2.5", () => {
      const result = parseSync(fromHex("fb4004000000000000"));
      expect(result._tag).toBe(CborKinds.Simple);
      if (result._tag === CborKinds.Simple && typeof result.value === "object" && result.value !== null) {
        expect(BigDecimal.toNumberUnsafe(result.value as BigDecimal.BigDecimal)).toBe(2.5);
        expect(result.addInfos).toBe(27);
      }
    });

    it("float16: 5.5", () => {
      const result = parseSync(fromHex("f94580"));
      expect(result._tag).toBe(CborKinds.Simple);
      if (result._tag === CborKinds.Simple && typeof result.value === "object" && result.value !== null) {
        expect(BigDecimal.toNumberUnsafe(result.value as BigDecimal.BigDecimal)).toBe(5.5);
        expect(result.addInfos).toBe(25);
      }
    });
  });

  describe("errors", () => {
    it("empty input", () => expect(() => parseSync(new Uint8Array(0))).toThrow());
    it("truncated input", () => expect(() => parseSync(fromHex("19"))).toThrow());
  });
});
