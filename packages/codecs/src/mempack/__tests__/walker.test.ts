import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
  MemPackDecodeError,
  MemPackEncodeError,
  packToUint8Array,
  unpackFromUint8Array,
} from "../index";
import { toCodecMemPack } from "../derive/toCodecMemPack";

// ────────────────────────────────────────────────────────────────────────────
// Walker property tests — exercises every arm of the AST dispatch in
// `toCodecMemPack`. Each property asserts TWO invariants per random value:
//
//   1. Round-trip:   unpack(pack(v)) === v
//   2. Size exact:   packedByteCount(v) === pack(v).byteLength
//
// The second is load-bearing for `packToUint8Array`, which pre-allocates a
// tight `Uint8Array` from `packedByteCount` then asserts final offset ===
// size. A walker arm that mis-counts silently (e.g., double-counts an
// optional tag) crashes at pack time rather than producing corrupt output —
// these properties catch that class of bug before it hits downstream ledger
// codecs.
// ────────────────────────────────────────────────────────────────────────────

const checkRoundTrip = <T, E>(
  schema: Schema.Codec<T, E, never, never>,
  arb: FastCheck.Arbitrary<T>,
  eq: (a: T, b: T) => boolean = (a, b) => Object.is(a, b),
  numRuns = 200,
): void => {
  const codec = toCodecMemPack(schema);
  FastCheck.assert(
    FastCheck.property(arb, (value) => {
      const packed = packToUint8Array(codec, value);
      if (packed.byteLength !== codec.packedByteCount(value)) return false;
      const decoded = unpackFromUint8Array(codec, packed);
      return eq(decoded, value);
    }),
    { numRuns },
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecMemPack — primitive AST kinds", () => {
  it("String (AST.String → text codec)", () => {
    checkRoundTrip(Schema.String, FastCheck.string());
  });

  it("Boolean (AST.Boolean → bool codec)", () => {
    checkRoundTrip(Schema.Boolean, FastCheck.boolean());
  });

  it("BigInt non-negative (AST.BigInt → varLen codec)", () => {
    checkRoundTrip(
      Schema.BigInt as Schema.Codec<bigint, bigint, never, never>,
      FastCheck.bigInt({ min: 0n, max: (1n << 60n) - 1n }),
      (a, b) => a === b,
    );
  });

  it("Number → float64 (IEEE 754 bit-exact)", () => {
    // Float64 preserves NaN payload and -0.0 bit-exactly through DataView;
    // Object.is handles both (-0.0 !== +0.0, NaN is self-equal).
    checkRoundTrip(Schema.Number, FastCheck.double(), Object.is);
  });

  it("Null (AST.Null → constant codec, 0 bytes)", () => {
    const codec = toCodecMemPack(Schema.Null);
    expect(codec.packedByteCount(null)).toBe(0);
    expect(packToUint8Array(codec, null)).toStrictEqual(new Uint8Array(0));
    expect(unpackFromUint8Array(codec, new Uint8Array(0))).toBeNull();
  });

  it("Literal number → constant codec, 0 bytes", () => {
    const codec = toCodecMemPack(Schema.Literal(42));
    expect(codec.packedByteCount(42)).toBe(0);
    expect(packToUint8Array(codec, 42)).toStrictEqual(new Uint8Array(0));
    expect(unpackFromUint8Array(codec, new Uint8Array(0))).toBe(42);
  });

  it("Literal string → constant codec, 0 bytes", () => {
    const codec = toCodecMemPack(Schema.Literal("ok"));
    expect(codec.packedByteCount("ok")).toBe(0);
    expect(packToUint8Array(codec, "ok")).toStrictEqual(new Uint8Array(0));
    expect(unpackFromUint8Array(codec, new Uint8Array(0))).toBe("ok");
  });

  it("Enum (numeric, position-indexed via Word8 Tag)", () => {
    enum Era {
      Byron = 0,
      Shelley = 1,
      Allegra = 2,
      Mary = 3,
      Alonzo = 4,
      Babbage = 5,
      Conway = 6,
    }
    const codec = toCodecMemPack(Schema.Enum(Era));
    for (const era of [Era.Byron, Era.Shelley, Era.Babbage, Era.Conway]) {
      const packed = packToUint8Array(codec, era);
      expect(packed.byteLength).toBe(1);
      expect(unpackFromUint8Array(codec, packed)).toBe(era);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Composites: Arrays (Tuple vs List), Objects (Struct)
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecMemPack — Arrays dispatch", () => {
  it("Tuple (fixed elements, no rest) — positional concat", () => {
    // Schema.Tuple([A, B]) lowers to AST.Arrays with elements=[A,B], rest=[].
    const Pair = Schema.Tuple([Schema.String, Schema.Boolean]);
    checkRoundTrip(
      Pair as unknown as Schema.Codec<
        readonly [string, boolean],
        readonly [string, boolean],
        never,
        never
      >,
      FastCheck.tuple(FastCheck.string(), FastCheck.boolean()),
      (a, b) => a[0] === b[0] && a[1] === b[1],
    );
  });

  it("List (empty elements, single rest) — Length-prefixed array", () => {
    // Schema.Array(inner) lowers to AST.Arrays with elements=[], rest=[inner].
    checkRoundTrip(
      Schema.Array(Schema.String) as unknown as Schema.Codec<
        ReadonlyArray<string>,
        ReadonlyArray<string>,
        never,
        never
      >,
      FastCheck.array(FastCheck.string(), { maxLength: 20 }),
      (a, b) => a.length === b.length && a.every((s, i) => s === b[i]),
    );
  });

  it("Empty list round-trips as single Length=0 byte", () => {
    const codec = toCodecMemPack(
      Schema.Array(Schema.Boolean) as unknown as Schema.Codec<
        ReadonlyArray<boolean>,
        ReadonlyArray<boolean>,
        never,
        never
      >,
    );
    const packed = packToUint8Array(codec, []);
    expect(packed).toStrictEqual(Uint8Array.of(0x00));
    expect(unpackFromUint8Array(codec, packed)).toStrictEqual([]);
  });
});

describe("toCodecMemPack — Objects (Struct)", () => {
  it("Struct — positional field concat, no key serialization", () => {
    const Person = Schema.Struct({ name: Schema.String, age: Schema.BigInt });
    checkRoundTrip(
      Person as unknown as Schema.Codec<
        { readonly name: string; readonly age: bigint },
        { readonly name: string; readonly age: bigint },
        never,
        never
      >,
      FastCheck.record({
        name: FastCheck.string(),
        age: FastCheck.bigInt({ min: 0n, max: (1n << 60n) - 1n }),
      }),
      (a, b) => a.name === b.name && a.age === b.age,
    );
  });

  it("Nested struct round-trip", () => {
    const Inner = Schema.Struct({ x: Schema.Boolean, y: Schema.String });
    const Outer = Schema.Struct({ a: Inner, b: Schema.BigInt });
    checkRoundTrip(
      Outer as unknown as Schema.Codec<
        {
          readonly a: { readonly x: boolean; readonly y: string };
          readonly b: bigint;
        },
        {
          readonly a: { readonly x: boolean; readonly y: string };
          readonly b: bigint;
        },
        never,
        never
      >,
      FastCheck.record({
        a: FastCheck.record({ x: FastCheck.boolean(), y: FastCheck.string() }),
        b: FastCheck.bigInt({ min: 0n, max: (1n << 40n) - 1n }),
      }),
      (a, b) => a.a.x === b.a.x && a.a.y === b.a.y && a.b === b.b,
    );
  });

  it("Struct with list field — size invariant holds", () => {
    const S = Schema.Struct({
      label: Schema.String,
      items: Schema.Array(Schema.Boolean),
    });
    const codec = toCodecMemPack(S);
    FastCheck.assert(
      FastCheck.property(
        FastCheck.record({
          label: FastCheck.string(),
          items: FastCheck.array(FastCheck.boolean(), { maxLength: 10 }),
        }),
        (value) => {
          const packed = packToUint8Array(
            codec,
            value as { label: string; items: readonly boolean[] },
          );
          return packed.byteLength === codec.packedByteCount(
            value as { label: string; items: readonly boolean[] },
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Tagged unions (MemPack: 1-byte Tag discriminator 0..255)
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecMemPack — tagged unions", () => {
  it("Numeric-discriminated Schema.Union → Word8 Tag + member fields", () => {
    // Numeric `_tag` enables MemPack's 1-byte tag encoding. String tags would
    // throw at derivation time (tag must be 0..255 integer).
    const U = Schema.Union([
      Schema.TaggedStruct(0, { payload: Schema.String }),
      Schema.TaggedStruct(1, { count: Schema.BigInt }),
      Schema.TaggedStruct(2, {}),
    ]).pipe(Schema.toTaggedUnion("_tag"));

    const codec = toCodecMemPack(
      U as unknown as Schema.Codec<
        | { readonly _tag: 0; readonly payload: string }
        | { readonly _tag: 1; readonly count: bigint }
        | { readonly _tag: 2 },
        unknown,
        never,
        never
      >,
    );

    type Variant =
      | { readonly _tag: 0; readonly payload: string }
      | { readonly _tag: 1; readonly count: bigint }
      | { readonly _tag: 2 };

    const cases: ReadonlyArray<Variant> = [
      { _tag: 0, payload: "hello" },
      { _tag: 1, count: 1_000_000n },
      { _tag: 2 },
    ];

    for (const v of cases) {
      const packed = packToUint8Array(codec, v);
      expect(packed.byteLength).toBe(codec.packedByteCount(v));
      const back = unpackFromUint8Array(codec, packed);
      expect(back).toStrictEqual(v);
    }
  });

  it("rejects string-discriminated unions at derivation time", () => {
    const StringU = Schema.Union([
      Schema.TaggedStruct("Foo", {}),
      Schema.TaggedStruct("Bar", {}),
    ]).pipe(Schema.toTaggedUnion("_tag"));

    expect(() => toCodecMemPack(StringU)).toThrow(
      /0\.\.255 integer tags/,
    );
  });

  it("rejects untagged unions at derivation time", () => {
    // Schema.Union without a common literal discriminator.
    const Untagged = Schema.Union([Schema.String, Schema.BigInt]);
    expect(() => toCodecMemPack(Untagged)).toThrow(/untagged unions/);
  });

  it("surfaces unknown tag bytes at unpack time as MemPackDecodeError", () => {
    const U = Schema.Union([
      Schema.TaggedStruct(0, {}),
      Schema.TaggedStruct(1, {}),
    ]).pipe(Schema.toTaggedUnion("_tag"));
    const codec = toCodecMemPack(U);
    // Tag byte 99 has no corresponding member.
    expect(() => unpackFromUint8Array(codec, Uint8Array.of(99))).toThrow(
      MemPackDecodeError,
    );
  });

  it("rejects encoding unknown _tag value as MemPackEncodeError", () => {
    const U = Schema.Union([
      Schema.TaggedStruct(0, {}),
      Schema.TaggedStruct(1, {}),
    ]).pipe(Schema.toTaggedUnion("_tag"));
    const codec = toCodecMemPack(U);
    // The walker's tag-number path throws when the runtime _tag isn't in the
    // declared literals. We construct the bad value manually to bypass schema.
    expect(() =>
      packToUint8Array(
        codec as unknown as import("../MemPackCodec").MemPackCodec<
          Record<string, unknown>
        >,
        { _tag: 7 },
      ),
    ).toThrow(MemPackEncodeError);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Memoization + recursion safety (Suspend branch)
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecMemPack — memoization & recursion", () => {
  it("top-level `memoize` caches per-schema: same Schema yields same codec", () => {
    const Pair = Schema.Struct({ a: Schema.String, b: Schema.Boolean });
    expect(toCodecMemPack(Pair)).toBe(toCodecMemPack(Pair));
  });

  it("per-AST WeakMap caches shared subtrees within a single walk", () => {
    const Inner = Schema.Struct({ x: Schema.BigInt });
    // Reuse `Inner` twice — the per-AST memo table ensures the walker only
    // materializes the Inner codec once.
    const Outer = Schema.Struct({ left: Inner, right: Inner });
    const codec = toCodecMemPack(Outer);
    const value = { left: { x: 1n }, right: { x: 2n } } as const;
    const packed = packToUint8Array(codec, value);
    expect(packed.byteLength).toBe(codec.packedByteCount(value));
    expect(unpackFromUint8Array(codec, packed)).toStrictEqual(value);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Size-invariant stress test — the most important MemPack property. Wrong
// `packedByteCount` silently corrupts composite codecs when the struct layer
// mis-estimates the child's size.
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecMemPack — packedByteCount === pack().byteLength invariant", () => {
  it("holds across a composite schema with every major AST kind", () => {
    enum Kind {
      Zero = 0,
      One = 1,
      Two = 2,
    }
    const Schema_ = Schema.Struct({
      name: Schema.String,
      flag: Schema.Boolean,
      count: Schema.BigInt,
      kind: Schema.Enum(Kind),
      tuple: Schema.Tuple([Schema.Boolean, Schema.String]),
      list: Schema.Array(Schema.BigInt),
    });
    const codec = toCodecMemPack(Schema_);
    type V = {
      readonly name: string;
      readonly flag: boolean;
      readonly count: bigint;
      readonly kind: Kind;
      readonly tuple: readonly [boolean, string];
      readonly list: ReadonlyArray<bigint>;
    };
    FastCheck.assert(
      FastCheck.property(
        FastCheck.record({
          name: FastCheck.string(),
          flag: FastCheck.boolean(),
          count: FastCheck.bigInt({ min: 0n, max: (1n << 50n) - 1n }),
          kind: FastCheck.constantFrom<Kind>(Kind.Zero, Kind.One, Kind.Two),
          tuple: FastCheck.tuple(FastCheck.boolean(), FastCheck.string()),
          list: FastCheck.array(
            FastCheck.bigInt({ min: 0n, max: (1n << 40n) - 1n }),
            { maxLength: 10 },
          ),
        }),
        (value) => {
          const v = value as V;
          const packed = packToUint8Array(codec, v);
          if (packed.byteLength !== codec.packedByteCount(v)) return false;
          const back = unpackFromUint8Array(codec, packed);
          return (
            back.name === v.name &&
            back.flag === v.flag &&
            back.count === v.count &&
            back.kind === v.kind &&
            back.tuple[0] === v.tuple[0] &&
            back.tuple[1] === v.tuple[1] &&
            back.list.length === v.list.length &&
            back.list.every((n, i) => n === v.list[i])
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
