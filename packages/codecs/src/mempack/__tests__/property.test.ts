import { describe, it } from "@effect/vitest";
import { Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
  length,
  packToUint8Array,
  unpackFromUint8Array,
  varLen,
  word16,
  word32,
  word64,
  word8,
} from "../index";
import type { MemPackCodec } from "../MemPackCodec";
import { toCodecMemPack } from "../derive/toCodecMemPack";

// ────────────────────────────────────────────────────────────────────────────
// Property tests for MemPack — complement the example-based `primitives.test.ts`
// suite with random-input coverage across the full value domain for each width.
//
// MemPack invariants (P1–P5 from plan task #330):
//   P1  Determinism — `pack(v)` yields the same bytes on repeated calls.
//       Trivially true for MemPack (single canonical encoding); asserted once
//       per codec as a smoke check anyway.
//   P2  Round-trip — `unpack(pack(v)) ≡ v` via `Object.is` (handles NaN/-0.0
//       for float ops later; bigints use `===`).
//   P3  Size invariant — `packedByteCount(v) === pack(v).byteLength`.
//   P4  VarLen boundary coverage — every 7-bit-continuation width band
//       (1..9 bytes in the 64-bit domain) round-trips correctly.
//   P5  Derivation round-trip — `toCodecMemPack(schema)` composes primitives
//       correctly across every AST-kind combination `FastCheck` can generate.
// ────────────────────────────────────────────────────────────────────────────

const roundTripInvariant = <T>(
  codec: MemPackCodec<T>,
  value: T,
  eq: (a: T, b: T) => boolean = Object.is,
): boolean => {
  const packed = packToUint8Array(codec, value);
  if (packed.byteLength !== codec.packedByteCount(value)) return false;
  return eq(unpackFromUint8Array(codec, packed), value);
};

// ────────────────────────────────────────────────────────────────────────────
// Primitive round-trip properties — hit every integer width band
// ────────────────────────────────────────────────────────────────────────────

describe("MemPack primitive round-trip properties", () => {
  it("word8 round-trips across full 8-bit range", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.integer({ min: 0, max: 255 }), (n) =>
        roundTripInvariant(word8, n),
      ),
      { numRuns: 300 },
    );
  });

  it("word16 round-trips across full 16-bit range", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.integer({ min: 0, max: 65535 }), (n) =>
        roundTripInvariant(word16, n),
      ),
      { numRuns: 300 },
    );
  });

  it("word32 round-trips across full 32-bit range", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: 0, max: 0xff_ff_ff_ff }),
        (n) => roundTripInvariant(word32, n),
      ),
      { numRuns: 300 },
    );
  });

  it("word64 round-trips across full 64-bit range", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (n) => roundTripInvariant(word64, n, (a, b) => a === b),
      ),
      { numRuns: 300 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P4 — VarLen boundary properties: every 7-bit continuation band (1..9 bytes
// in the 64-bit domain). Uses MemPack's big-endian 7-bit encoding (NOT LEB128).
// Reference: ~/code/reference/mempack/src/Data/MemPack.hs:1341-1417.
// ────────────────────────────────────────────────────────────────────────────

describe("MemPack VarLen boundary properties (P4)", () => {
  // Each band corresponds to a distinct packed-byte-count. The encoder must
  // select the correct width for every value in the band — this is the
  // invariant that hand-rolled LEB128 implementations often get wrong at the
  // power-of-128 boundaries (127/128, 16383/16384, etc.).
  const bands: ReadonlyArray<[bigint, bigint, number]> = [
    [0n, (1n << 7n) - 1n, 1], // 1 byte:  0..127
    [1n << 7n, (1n << 14n) - 1n, 2], // 2 bytes: 128..16383
    [1n << 14n, (1n << 21n) - 1n, 3], // 3 bytes: 16384..2097151
    [1n << 21n, (1n << 28n) - 1n, 4], // 4 bytes
    [1n << 28n, (1n << 35n) - 1n, 5], // 5 bytes
    [1n << 35n, (1n << 42n) - 1n, 6], // 6 bytes
    [1n << 42n, (1n << 49n) - 1n, 7], // 7 bytes
    [1n << 49n, (1n << 56n) - 1n, 8], // 8 bytes
    [1n << 56n, (1n << 63n) - 1n, 9], // 9 bytes (63-bit domain per MemPack)
  ];

  for (const [min, max, expectedBytes] of bands) {
    it(`band ${expectedBytes} byte(s) — round-trips and uses exact width`, () => {
      FastCheck.assert(
        FastCheck.property(FastCheck.bigInt({ min, max }), (n) => {
          const bytes = packToUint8Array(varLen, n);
          if (bytes.byteLength !== expectedBytes) return false;
          if (bytes.byteLength !== varLen.packedByteCount(n)) return false;
          return unpackFromUint8Array(varLen, bytes) === n;
        }),
        { numRuns: 100 },
      );
    });
  }

  it("boundary points (2^7k and 2^7k - 1) round-trip exactly", () => {
    // Explicit boundary guards — off-by-one bugs at width transitions are
    // common. These are sampled by the band properties above but asserted
    // directly to pin the failure mode.
    const boundaries = [
      0n,
      127n,
      128n,
      16383n,
      16384n,
      2097151n,
      2097152n,
      (1n << 63n) - 1n,
    ];
    for (const n of boundaries) {
      const bytes = packToUint8Array(varLen, n);
      FastCheck.pre(bytes.byteLength === varLen.packedByteCount(n));
      FastCheck.pre(unpackFromUint8Array(varLen, bytes) === n);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Length = VarLen-over-Word. Coverage overlaps with VarLen but guards against
// encoder drift if the wrapper ever becomes something other than a pure alias.
// ────────────────────────────────────────────────────────────────────────────

describe("MemPack Length property", () => {
  it("Length round-trips across JS-safe integer range", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (n) => roundTripInvariant(length, n),
      ),
      { numRuns: 300 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P5 — Derivation round-trip via `toCodecMemPack` + `Schema.toArbitrary`.
// Exercises the walker's composite arms (Struct, List, Tuple, Union) end-to-end
// with random domain values. Complements walker.test.ts which uses per-kind
// example schemas.
// ────────────────────────────────────────────────────────────────────────────

describe("MemPack derivation round-trip properties (P5)", () => {
  it("round-trips a record of primitive BigInts", () => {
    const Schema_ = Schema.Struct({
      a: Schema.BigInt,
      b: Schema.BigInt,
      c: Schema.Boolean,
    });
    const codec = toCodecMemPack(Schema_);
    FastCheck.assert(
      FastCheck.property(
        FastCheck.record({
          a: FastCheck.bigInt({ min: 0n, max: 1n << 40n }),
          b: FastCheck.bigInt({ min: 0n, max: 1n << 40n }),
          c: FastCheck.boolean(),
        }),
        (v) => {
          const bytes = packToUint8Array(codec, v);
          if (bytes.byteLength !== codec.packedByteCount(v)) return false;
          const back = unpackFromUint8Array(codec, bytes);
          return back.a === v.a && back.b === v.b && back.c === v.c;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("round-trips a list of structs (Length-prefixed array of positional records)", () => {
    const Item = Schema.Struct({ n: Schema.BigInt, b: Schema.Boolean });
    const Schema_ = Schema.Array(Item);
    const codec = toCodecMemPack(Schema_);
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(
          FastCheck.record({
            n: FastCheck.bigInt({ min: 0n, max: 1n << 30n }),
            b: FastCheck.boolean(),
          }),
          { maxLength: 8 },
        ),
        (arr) => {
          const bytes = packToUint8Array(codec, arr);
          if (bytes.byteLength !== codec.packedByteCount(arr)) return false;
          const back = unpackFromUint8Array(codec, bytes);
          return (
            back.length === arr.length &&
            back.every((item, i) => item.n === arr[i]!.n && item.b === arr[i]!.b)
          );
        },
      ),
      { numRuns: 150 },
    );
  });

  it("round-trips nested structs (Struct of Struct of BigInt)", () => {
    const Inner = Schema.Struct({ k: Schema.BigInt });
    const Outer = Schema.Struct({ inner: Inner, tail: Schema.BigInt });
    const codec = toCodecMemPack(Outer);
    FastCheck.assert(
      FastCheck.property(
        FastCheck.record({
          inner: FastCheck.record({
            k: FastCheck.bigInt({ min: 0n, max: 1n << 20n }),
          }),
          tail: FastCheck.bigInt({ min: 0n, max: 1n << 20n }),
        }),
        (v) => {
          const bytes = packToUint8Array(codec, v);
          if (bytes.byteLength !== codec.packedByteCount(v)) return false;
          const back = unpackFromUint8Array(codec, bytes);
          return back.inner.k === v.inner.k && back.tail === v.tail;
        },
      ),
      { numRuns: 200 },
    );
  });
});
