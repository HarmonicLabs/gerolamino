import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { CborKinds } from "../CborValue";
import { toCodecCbor, toCodecCborBytes } from "../derive/toCodecCbor";

// ────────────────────────────────────────────────────────────────────────────
// Helpers — run an Effect synchronously; most of these tests are pure, so
// `Effect.runSync` is fine. If a schema adds RD/RE services later, swap to
// `Effect.runPromise`.
// ────────────────────────────────────────────────────────────────────────────

const encode = <T>(schema: Schema.Codec<T, unknown, never, never>, value: T): unknown =>
  Effect.runSync(Schema.encodeEffect(schema)(value));
const decode = <T>(schema: Schema.Codec<T, unknown, never, never>, encoded: unknown): T =>
  Effect.runSync(Schema.decodeEffect(schema)(encoded));

// ────────────────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecCbor — primitives", () => {
  it("String ↔ CborValue.Text", () => {
    const codec = toCodecCbor(Schema.String);
    expect(encode(codec, "hi")).toStrictEqual({ _tag: CborKinds.Text, text: "hi" });
    expect(decode(codec, { _tag: CborKinds.Text, text: "hi" })).toBe("hi");
  });

  it("Number integer ↔ CborValue.UInt / NegInt", () => {
    const codec = toCodecCbor(Schema.Number);
    expect(encode(codec, 42)).toStrictEqual({ _tag: CborKinds.UInt, num: 42n });
    expect(encode(codec, -3)).toStrictEqual({ _tag: CborKinds.NegInt, num: -3n });
    expect(decode(codec, { _tag: CborKinds.UInt, num: 99n })).toBe(99);
    expect(decode(codec, { _tag: CborKinds.NegInt, num: -7n })).toBe(-7);
  });

  it("BigInt ↔ UInt / NegInt (in 64-bit range)", () => {
    const codec = toCodecCbor(Schema.BigInt);
    expect(encode(codec, 100n)).toStrictEqual({ _tag: CborKinds.UInt, num: 100n });
    expect(encode(codec, -5n)).toStrictEqual({ _tag: CborKinds.NegInt, num: -5n });
  });

  it("BigInt out-of-range ↔ Tag(2)/Tag(3) bignum", () => {
    const codec = toCodecCbor(Schema.BigInt);
    const huge = (1n << 70n) + 1n;
    const encoded = encode(codec, huge);
    expect(encoded).toMatchObject({ _tag: CborKinds.Tag, tag: 2n });
    expect(decode(codec, encoded)).toBe(huge);

    const veryNeg = -(1n << 70n);
    const encodedNeg = encode(codec, veryNeg);
    expect(encodedNeg).toMatchObject({ _tag: CborKinds.Tag, tag: 3n });
    expect(decode(codec, encodedNeg)).toBe(veryNeg);
  });

  it("Boolean ↔ Simple(bool)", () => {
    const codec = toCodecCbor(Schema.Boolean);
    expect(encode(codec, true)).toStrictEqual({ _tag: CborKinds.Simple, value: true });
    expect(decode(codec, { _tag: CborKinds.Simple, value: false })).toBe(false);
  });

  it("Null ↔ Simple(null)", () => {
    const codec = toCodecCbor(Schema.Null);
    expect(encode(codec, null)).toStrictEqual({ _tag: CborKinds.Simple, value: null });
    expect(decode(codec, { _tag: CborKinds.Simple, value: null })).toBeNull();
  });

  it("Literal ↔ its CBOR image", () => {
    const codec = toCodecCbor(Schema.Literal("ok"));
    expect(encode(codec, "ok")).toStrictEqual({ _tag: CborKinds.Text, text: "ok" });
  });

  it("Enum (numeric) ↔ UInt", () => {
    enum E {
      A = 0,
      B = 1,
    }
    const codec = toCodecCbor(Schema.Enum(E));
    expect(encode(codec, E.B)).toStrictEqual({ _tag: CborKinds.UInt, num: 1n });
    expect(decode(codec, { _tag: CborKinds.UInt, num: 0n })).toBe(E.A);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Composites: Struct (Map), Arrays (Array), Tuple
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecCbor — composites", () => {
  it("Struct ↔ Map with Text keys sorted lexicographically", () => {
    const Person = Schema.Struct({ name: Schema.String, age: Schema.Number });
    const codec = toCodecCbor(Person);
    const encoded = encode(codec, { name: "Ada", age: 42 });
    expect(encoded).toStrictEqual({
      _tag: CborKinds.Map,
      entries: [
        { k: { _tag: CborKinds.Text, text: "age" }, v: { _tag: CborKinds.UInt, num: 42n } },
        { k: { _tag: CborKinds.Text, text: "name" }, v: { _tag: CborKinds.Text, text: "Ada" } },
      ],
    });
    expect(decode(codec, encoded)).toStrictEqual({ name: "Ada", age: 42 });
  });

  it("Array of primitives ↔ CborValue.Array", () => {
    const codec = toCodecCbor(Schema.Array(Schema.Number));
    const encoded = encode(codec, [1, 2, 3]);
    expect(encoded).toStrictEqual({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 1n },
        { _tag: CborKinds.UInt, num: 2n },
        { _tag: CborKinds.UInt, num: 3n },
      ],
    });
    expect(decode(codec, encoded)).toStrictEqual([1, 2, 3]);
  });

  it("nested Struct/Array round-trips", () => {
    const Post = Schema.Struct({
      title: Schema.String,
      likes: Schema.Number,
      tags: Schema.Array(Schema.String),
    });
    const codec = toCodecCbor(Post);
    const value = { title: "hi", likes: 10, tags: ["a", "b"] };
    expect(decode(codec, encode(codec, value))).toStrictEqual(value);
  });

  it("deeply nested", () => {
    const Schema_ = Schema.Struct({
      a: Schema.Struct({ b: Schema.Array(Schema.Struct({ c: Schema.BigInt })) }),
    });
    const codec = toCodecCbor(Schema_);
    const value = { a: { b: [{ c: 1n }, { c: 2n }] } };
    expect(decode(codec, encode(codec, value))).toStrictEqual(value);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// toCodecCborBytes — composition with CborBytes for end-to-end bytes round-trip
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecCborBytes — bytes round-trip", () => {
  it("String round-trips through Uint8Array", () => {
    const codec = toCodecCborBytes(Schema.String);
    const bytes = Effect.runSync(Schema.encodeEffect(codec)("hello"));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Effect.runSync(Schema.decodeEffect(codec)(bytes))).toBe("hello");
  });

  it("Struct round-trips through Uint8Array", () => {
    const Person = Schema.Struct({ name: Schema.String, age: Schema.Number });
    const codec = toCodecCborBytes(Person);
    const value = { name: "Ada", age: 42 };
    const bytes = Effect.runSync(Schema.encodeEffect(codec)(value));
    expect(Effect.runSync(Schema.decodeEffect(codec)(bytes))).toStrictEqual(value);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property tests — fast-check over random domain values via Schema.toArbitrary
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecCbor — property tests", () => {
  it("String round-trip", () => {
    const codec = toCodecCbor(Schema.String);
    FastCheck.assert(
      FastCheck.property(FastCheck.string(), (s) => decode(codec, encode(codec, s)) === s),
      { numRuns: 300 },
    );
  });

  it("BigInt round-trip across integer and bignum ranges", () => {
    const codec = toCodecCbor(Schema.BigInt);
    FastCheck.assert(
      FastCheck.property(
        FastCheck.bigInt({ min: -(1n << 100n), max: 1n << 100n }),
        (n) => decode(codec, encode(codec, n)) === n,
      ),
      { numRuns: 300 },
    );
  });

  it("Struct round-trip preserves value", () => {
    const Person = Schema.Struct({ name: Schema.String, age: Schema.Number });
    const codec = toCodecCbor(Person);
    FastCheck.assert(
      FastCheck.property(
        FastCheck.record({
          name: FastCheck.string(),
          age: FastCheck.integer({ min: 0, max: 150 }),
        }),
        (person) => {
          const out = decode(codec, encode(codec, person));
          return out.name === person.name && out.age === person.age;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Array<Number> round-trip preserves elements", () => {
    const codec = toCodecCbor(Schema.Array(Schema.Number));
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(FastCheck.integer({ min: -1_000_000, max: 1_000_000 }), {
          maxLength: 20,
        }),
        (arr) => {
          const out = decode(codec, encode(codec, arr));
          return out.length === arr.length && out.every((v, i) => v === arr[i]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("toCodecCborBytes round-trip (bytes-level)", () => {
    const codec = toCodecCborBytes(Schema.Struct({ n: Schema.BigInt, s: Schema.String }));
    FastCheck.assert(
      FastCheck.property(
        FastCheck.record({
          n: FastCheck.bigInt({ min: 0n, max: 1n << 40n }),
          s: FastCheck.string(),
        }),
        (value) => {
          const bytes = Effect.runSync(Schema.encodeEffect(codec)(value));
          const back = Effect.runSync(Schema.decodeEffect(codec)(bytes));
          return back.n === value.n && back.s === value.s;
        },
      ),
      { numRuns: 150 },
    );
  });
});
