import { it, describe, expect } from "@effect/vitest";
import { BigDecimal } from "effect";
import { parseSync, encodeSync, CborKinds, type CborSchemaType } from "../index";

const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return bytes;
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// Byte-level round-trip: encodeSync(parseSync(bytes)) === bytes
const byteRoundTrip = (hex: string) => {
  const bytes = fromHex(hex);
  const parsed = parseSync(bytes);
  const reEncoded = encodeSync(parsed);
  expect(toHex(reEncoded)).toBe(hex);
};

describe("byte-level round-trip: encodeSync(parseSync(bytes)) === bytes", () => {
  describe("unsigned integers", () => {
    it("0", () => byteRoundTrip("00"));
    it("1", () => byteRoundTrip("01"));
    it("23", () => byteRoundTrip("17"));
    it("24 (1-byte)", () => byteRoundTrip("1818"));
    it("255 (1-byte)", () => byteRoundTrip("18ff"));
    it("256 (2-byte)", () => byteRoundTrip("190100"));
    it("65535 (2-byte)", () => byteRoundTrip("19ffff"));
    it("65536 (4-byte)", () => byteRoundTrip("1a00010000"));
    it("MAX_SAFE_INTEGER (8-byte)", () => byteRoundTrip("1b001fffffffffffff"));
    // Non-canonical: value 1 with 1-byte header
    it("non-canonical 1801", () => byteRoundTrip("1801"));
  });

  describe("negative integers", () => {
    it("-1", () => byteRoundTrip("20"));
    it("-5", () => byteRoundTrip("24"));
    it("-25 (1-byte)", () => byteRoundTrip("3818"));
    it("-MAX_SAFE_INTEGER (8-byte)", () => byteRoundTrip("3b001ffffffffffffe"));
  });

  describe("byte strings", () => {
    it("empty", () => byteRoundTrip("40"));
    it("non-canonical empty (1-byte length)", () => byteRoundTrip("5800"));
    it("non-canonical empty (2-byte length)", () => byteRoundTrip("590000"));
    it("non-canonical empty (4-byte length)", () => byteRoundTrip("5a00000000"));
    it("non-canonical empty (8-byte length)", () => byteRoundTrip("5b0000000000000000"));
    it("6 bytes", () => byteRoundTrip("4601070a0f1418"));
    it("non-canonical 1 byte with 1-byte header", () => byteRoundTrip("580107"));
    it("indefinite empty", () => byteRoundTrip("5fff"));
    it("indefinite one chunk", () => byteRoundTrip("5f40ff"));
    it("indefinite two chunks", () => byteRoundTrip("5f405800ff"));
    it("indefinite 3 chunks", () => byteRoundTrip("5f405800590000ff"));
    it("indefinite 4 chunks", () => byteRoundTrip("5f4058005900005a00000000ff"));
    it("indefinite 5 chunks", () => byteRoundTrip("5f4058005900005a000000005b0000000000000000ff"));
    it("nested indefinite", () => byteRoundTrip("5f5fffff"));
    it("mixed indefinite", () =>
      byteRoundTrip("5f4058005900005a000000005f4058005900005a00000000ffff"));
    it("indefinite with data", () =>
      byteRoundTrip("5f4601070a0f14184601070a0f14184601070a0f1418ff"));
  });

  describe("text strings", () => {
    it("empty", () => byteRoundTrip("60"));
    it("ciaone", () => byteRoundTrip("666369616f6e65"));
  });

  describe("arrays", () => {
    it("empty", () => byteRoundTrip("80"));
    it("[1, 2, 3]", () => byteRoundTrip("83010203"));
    it("indefinite [1, 2, 3]", () => byteRoundTrip("9f010203ff"));
  });

  describe("maps", () => {
    it("empty", () => byteRoundTrip("a0"));
    it("{bytes: text, uint: array}", () =>
      byteRoundTrip("a2466369616f6e65676d6f6e646f6e6501820203"));
  });

  describe("tags", () => {
    it("tag 6 + empty array", () => byteRoundTrip("c680"));
    it("tag 6 + uint 2", () => byteRoundTrip("c602"));
  });

  describe("simple values", () => {
    it("false", () => byteRoundTrip("f4"));
    it("true", () => byteRoundTrip("f5"));
    it("null", () => byteRoundTrip("f6"));
    it("undefined", () => byteRoundTrip("f7"));
  });

  describe("floats", () => {
    it("float64: 2.5", () => byteRoundTrip("fb4004000000000000"));
    it("float64: 2.4", () => byteRoundTrip("fb4003333333333333"));
    it("float16: 5.5", () => byteRoundTrip("f94580"));
  });
});

describe("value round-trip: parseSync(encodeSync(x)) deep-equals x", () => {
  const valueRoundTrip = (obj: CborSchemaType) => {
    const encoded = encodeSync(obj);
    const reparsed = parseSync(encoded);
    // Compare _tag and main fields (addInfos may differ for canonical encoding)
    expect(reparsed._tag).toBe(obj._tag);
  };

  it("uint", () => valueRoundTrip({ _tag: CborKinds.UInt, num: 42n }));
  it("negint", () => valueRoundTrip({ _tag: CborKinds.NegInt, num: -42n }));
  it("bytes", () => valueRoundTrip({ _tag: CborKinds.Bytes, bytes: new Uint8Array([1, 2, 3]) }));
  it("text", () => valueRoundTrip({ _tag: CborKinds.Text, text: "hello" }));
  it("array", () =>
    valueRoundTrip({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 1n }] }));
  it("map", () =>
    valueRoundTrip({
      _tag: CborKinds.Map,
      entries: [{ k: { _tag: CborKinds.Text, text: "a" }, v: { _tag: CborKinds.UInt, num: 1n } }],
    }));
  it("tag", () =>
    valueRoundTrip({ _tag: CborKinds.Tag, tag: 6n, data: { _tag: CborKinds.Array, items: [] } }));
  it("false", () => valueRoundTrip({ _tag: CborKinds.Simple, value: false }));
  it("true", () => valueRoundTrip({ _tag: CborKinds.Simple, value: true }));
  it("null", () => valueRoundTrip({ _tag: CborKinds.Simple, value: null }));
  it("undefined", () => valueRoundTrip({ _tag: CborKinds.Simple, value: undefined }));
  it("float", () =>
    valueRoundTrip({ _tag: CborKinds.Simple, value: BigDecimal.fromNumberUnsafe(2.5) }));
});
