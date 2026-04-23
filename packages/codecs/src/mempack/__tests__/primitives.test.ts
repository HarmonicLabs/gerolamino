import { Equal } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  bool,
  bytes,
  int16,
  int32,
  int64,
  int8,
  length,
  MemPackDecodeError,
  packToUint8Array,
  tag,
  text,
  unpackFromUint8Array,
  varLen,
  varLenNumber,
  word16,
  word32,
  word64,
  word8,
} from "../index";
import type { MemPackCodec } from "../MemPackCodec";

const roundTrip = <T>(
  codec: MemPackCodec<T>,
  value: T,
  eq: (a: T, b: T) => boolean = Object.is,
): Uint8Array => {
  const bytes = packToUint8Array(codec, value);
  expect(bytes.byteLength).toBe(codec.packedByteCount(value));
  const decoded = unpackFromUint8Array(codec, bytes);
  expect(eq(decoded, value)).toBe(true);
  return bytes;
};

describe("mempack/primitives/words", () => {
  it("word8 round-trip", () => {
    for (const v of [0, 1, 127, 128, 255]) {
      const bytes = roundTrip(word8, v);
      expect(bytes).toStrictEqual(Uint8Array.of(v));
    }
  });

  it("word16 is little-endian", () => {
    const bytes = roundTrip(word16, 0x1234);
    expect(bytes).toStrictEqual(Uint8Array.of(0x34, 0x12));
  });

  it("word32 is little-endian", () => {
    const bytes = roundTrip(word32, 0x12345678);
    expect(bytes).toStrictEqual(Uint8Array.of(0x78, 0x56, 0x34, 0x12));
  });

  it("word64 round-trips max value", () => {
    const max = (1n << 64n) - 1n;
    const bytes = roundTrip(word64, max, (a, b) => a === b);
    expect(bytes).toStrictEqual(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff));
  });
});

describe("mempack/primitives/ints", () => {
  it("int8 handles negatives via two's complement", () => {
    const bytes = roundTrip(int8, -1);
    expect(bytes).toStrictEqual(Uint8Array.of(0xff));
  });

  it("int16 round-trips range boundaries", () => {
    for (const v of [-32768, -1, 0, 1, 32767]) {
      roundTrip(int16, v);
    }
  });

  it("int32 round-trips full range", () => {
    for (const v of [-0x80000000, -1, 0, 1, 0x7fffffff]) {
      roundTrip(int32, v);
    }
  });

  it("int64 round-trips 64-bit signed bigints", () => {
    const min = -(1n << 63n);
    const max = (1n << 63n) - 1n;
    for (const v of [min, -1n, 0n, 1n, max]) {
      roundTrip(int64, v, (a, b) => a === b);
    }
  });
});

describe("mempack/primitives/bool", () => {
  it("round-trips true/false", () => {
    expect(roundTrip(bool, true)).toStrictEqual(Uint8Array.of(1));
    expect(roundTrip(bool, false)).toStrictEqual(Uint8Array.of(0));
  });

  it("rejects tag bytes outside 0x00/0x01", () => {
    const buf = Uint8Array.of(2);
    expect(() => unpackFromUint8Array(bool, buf)).toThrow();
  });
});

describe("mempack/primitives/tag", () => {
  it("encodes 0..255 as a single byte", () => {
    for (const v of [0, 1, 42, 128, 255]) {
      expect(roundTrip(tag, v)).toStrictEqual(Uint8Array.of(v));
    }
  });

  it("rejects out-of-range Tag values on pack", () => {
    expect(() => packToUint8Array(tag, -1)).toThrow();
    expect(() => packToUint8Array(tag, 256)).toThrow();
    expect(() => packToUint8Array(tag, 1.5)).toThrow();
  });
});

describe("mempack/primitives/varlen", () => {
  // MemPack uses BIG-ENDIAN 7-bit continuation encoding (NOT LEB128).
  // Reference: ~/code/reference/mempack/src/Data/MemPack.hs:1341-1417
  // (`packIntoCont7` writes the high-order 7 bits first).
  const vectors: Array<[bigint, Uint8Array]> = [
    [0n, Uint8Array.of(0x00)],
    [1n, Uint8Array.of(0x01)],
    [127n, Uint8Array.of(0x7f)],
    [128n, Uint8Array.of(0x81, 0x00)], // 2 bytes: (1 | 0x80) then 0
    [16383n, Uint8Array.of(0xff, 0x7f)], // 2 bytes: (127 | 0x80) then 127
    [16384n, Uint8Array.of(0x81, 0x80, 0x00)], // 3 bytes: (1 | 0x80), (0 | 0x80), 0
  ];

  it.each(vectors)("varLen(%s) canonical encoding", (n, expected) => {
    const bytes = packToUint8Array(varLen, n);
    expect(Equal.equals(bytes, expected)).toBe(true);
    expect(unpackFromUint8Array(varLen, bytes)).toBe(n);
  });

  it("varLen rejects negatives", () => {
    expect(() => packToUint8Array(varLen, -1n)).toThrow();
  });

  it("varLenNumber bridges to JS Number for safe-range values", () => {
    for (const v of [0, 127, 128, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      roundTrip(varLenNumber, v);
    }
  });

  it("packedByteCount matches actual packed length for varLen", () => {
    for (const n of [0n, 127n, 128n, 16383n, 16384n, 1n << 40n]) {
      expect(packToUint8Array(varLen, n).byteLength).toBe(varLen.packedByteCount(n));
    }
  });
});

describe("mempack/primitives/length", () => {
  it("round-trips standard lengths", () => {
    for (const v of [0, 1, 127, 128, 65535, 1_000_000]) {
      roundTrip(length, v);
    }
  });

  it("rejects negative lengths", () => {
    expect(() => packToUint8Array(length, -1)).toThrow();
  });
});

describe("mempack/primitives/bytes", () => {
  it("empty bytes: length-0 prefix + no payload", () => {
    const bytes_ = roundTrip(bytes, new Uint8Array(0), Equal.equals);
    expect(bytes_).toStrictEqual(Uint8Array.of(0x00));
  });

  it("small bytes: inline length + payload", () => {
    const payload = Uint8Array.of(0xaa, 0xbb, 0xcc);
    const packed = roundTrip(bytes, payload, Equal.equals);
    expect(packed).toStrictEqual(Uint8Array.of(0x03, 0xaa, 0xbb, 0xcc));
  });

  it("128-byte payload: 2-byte length prefix", () => {
    const payload = new Uint8Array(128).fill(0xab);
    const packed = packToUint8Array(bytes, payload);
    // VarLen(128) = 0x81 0x00 (big-endian 7-bit), then 128 bytes payload
    expect(packed.byteLength).toBe(2 + 128);
    expect(packed[0]).toBe(0x81);
    expect(packed[1]).toBe(0x00);
    const decoded = unpackFromUint8Array(bytes, packed);
    expect(Equal.equals(decoded, payload)).toBe(true);
  });
});

describe("mempack/primitives/text", () => {
  it("empty string: length-0 prefix", () => {
    const bytes_ = roundTrip(text, "");
    expect(bytes_).toStrictEqual(Uint8Array.of(0x00));
  });

  it("ASCII text round-trip", () => {
    const packed = roundTrip(text, "hello");
    expect(packed).toStrictEqual(Uint8Array.of(0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f));
  });

  it("UTF-8 multi-byte code points", () => {
    const s = "καλημέρα 🌅";
    const packed = packToUint8Array(text, s);
    const decoded = unpackFromUint8Array(text, packed);
    expect(decoded).toBe(s);
  });

  it("rejects invalid UTF-8", () => {
    // 0xff is not a valid starting byte in UTF-8
    const malformed = Uint8Array.of(0x01, 0xff);
    expect(() => unpackFromUint8Array(text, malformed)).toThrow();
  });
});

describe("mempack/MemPackCodec helpers", () => {
  it("unpackFromUint8Array rejects trailing garbage", () => {
    // Valid word8 encoding followed by extra bytes should fail.
    const buf = Uint8Array.of(42, 99);
    expect(() => unpackFromUint8Array(word8, buf)).toThrow(MemPackDecodeError);
  });

  it("packedByteCount invariant: every primitive reports exact size", () => {
    const check = <T>(codec: MemPackCodec<T>, value: T): void => {
      const packed = packToUint8Array(codec, value);
      expect(packed.byteLength).toBe(codec.packedByteCount(value));
    };
    check(word8, 42);
    check(word16, 1000);
    check(word32, 1_000_000);
    check(word64, 1n << 40n);
    check(int8, -1);
    check(int16, -1000);
    check(int32, -1_000_000);
    check(int64, -(1n << 40n));
    check(bool, true);
    check(tag, 128);
    check(varLen, 1n << 20n);
    check(varLenNumber, 1_000_000);
    check(length, 500);
    check(bytes, Uint8Array.of(1, 2, 3, 4, 5));
    check(text, "testing");
  });
});
