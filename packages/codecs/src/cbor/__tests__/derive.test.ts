import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { CborKinds } from "../CborValue";
import { toCodecCbor, toCodecCborBytes } from "../derive/toCodecCbor";

// ────────────────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecCbor — primitives", () => {
  it.effect("String ↔ CborValue.Text", () =>
    Effect.gen(function* () {
      const codec = toCodecCbor(Schema.String);
      const encoded = yield* Schema.encodeEffect(codec)("hi");
      expect(encoded).toStrictEqual({ _tag: CborKinds.Text, text: "hi" });
      const decoded = yield* Schema.decodeEffect(codec)({ _tag: CborKinds.Text, text: "hi" });
      expect(decoded).toBe("hi");
    }),
  );

  it.effect("Number integer ↔ CborValue.UInt / NegInt", () =>
    Effect.gen(function* () {
      const codec = toCodecCbor(Schema.Number);
      expect(yield* Schema.encodeEffect(codec)(42)).toStrictEqual({
        _tag: CborKinds.UInt,
        num: 42n,
      });
      expect(yield* Schema.encodeEffect(codec)(-3)).toStrictEqual({
        _tag: CborKinds.NegInt,
        num: -3n,
      });
      expect(yield* Schema.decodeEffect(codec)({ _tag: CborKinds.UInt, num: 99n })).toBe(99);
      expect(yield* Schema.decodeEffect(codec)({ _tag: CborKinds.NegInt, num: -7n })).toBe(-7);
    }),
  );

  it.effect("BigInt ↔ UInt / NegInt (in 64-bit range)", () =>
    Effect.gen(function* () {
      const codec = toCodecCbor(Schema.BigInt);
      expect(yield* Schema.encodeEffect(codec)(100n)).toStrictEqual({
        _tag: CborKinds.UInt,
        num: 100n,
      });
      expect(yield* Schema.encodeEffect(codec)(-5n)).toStrictEqual({
        _tag: CborKinds.NegInt,
        num: -5n,
      });
    }),
  );

  it.effect("BigInt out-of-range ↔ Tag(2)/Tag(3) bignum", () =>
    Effect.gen(function* () {
      const codec = toCodecCbor(Schema.BigInt);
      const huge = (1n << 70n) + 1n;
      const encoded = yield* Schema.encodeEffect(codec)(huge);
      expect(encoded).toMatchObject({ _tag: CborKinds.Tag, tag: 2n });
      expect(yield* Schema.decodeEffect(codec)(encoded)).toBe(huge);

      const veryNeg = -(1n << 70n);
      const encodedNeg = yield* Schema.encodeEffect(codec)(veryNeg);
      expect(encodedNeg).toMatchObject({ _tag: CborKinds.Tag, tag: 3n });
      expect(yield* Schema.decodeEffect(codec)(encodedNeg)).toBe(veryNeg);
    }),
  );

  it.effect("Boolean ↔ Simple(bool)", () =>
    Effect.gen(function* () {
      const codec = toCodecCbor(Schema.Boolean);
      expect(yield* Schema.encodeEffect(codec)(true)).toStrictEqual({
        _tag: CborKinds.Simple,
        value: true,
      });
      expect(yield* Schema.decodeEffect(codec)({ _tag: CborKinds.Simple, value: false })).toBe(
        false,
      );
    }),
  );

  it.effect("Null ↔ Simple(null)", () =>
    Effect.gen(function* () {
      const codec = toCodecCbor(Schema.Null);
      expect(yield* Schema.encodeEffect(codec)(null)).toStrictEqual({
        _tag: CborKinds.Simple,
        value: null,
      });
      expect(yield* Schema.decodeEffect(codec)({ _tag: CborKinds.Simple, value: null })).toBeNull();
    }),
  );

  it.effect("Literal ↔ its CBOR image", () =>
    Effect.gen(function* () {
      const codec = toCodecCbor(Schema.Literal("ok"));
      expect(yield* Schema.encodeEffect(codec)("ok")).toStrictEqual({
        _tag: CborKinds.Text,
        text: "ok",
      });
    }),
  );

  it.effect("Enum (numeric) ↔ UInt", () =>
    Effect.gen(function* () {
      enum E {
        A = 0,
        B = 1,
      }
      const codec = toCodecCbor(Schema.Enum(E));
      expect(yield* Schema.encodeEffect(codec)(E.B)).toStrictEqual({
        _tag: CborKinds.UInt,
        num: 1n,
      });
      expect(yield* Schema.decodeEffect(codec)({ _tag: CborKinds.UInt, num: 0n })).toBe(E.A);
    }),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Composites: Struct (Map), Arrays (Array), Tuple
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecCbor — composites", () => {
  it.effect("Struct ↔ Map with Text keys sorted lexicographically", () =>
    Effect.gen(function* () {
      const Person = Schema.Struct({ name: Schema.String, age: Schema.Number });
      const codec = toCodecCbor(Person);
      const encoded = yield* Schema.encodeEffect(codec)({ name: "Ada", age: 42 });
      expect(encoded).toStrictEqual({
        _tag: CborKinds.Map,
        entries: [
          { k: { _tag: CborKinds.Text, text: "age" }, v: { _tag: CborKinds.UInt, num: 42n } },
          { k: { _tag: CborKinds.Text, text: "name" }, v: { _tag: CborKinds.Text, text: "Ada" } },
        ],
      });
      expect(yield* Schema.decodeEffect(codec)(encoded)).toStrictEqual({ name: "Ada", age: 42 });
    }),
  );

  it.effect("Array of primitives ↔ CborValue.Array", () =>
    Effect.gen(function* () {
      const codec = toCodecCbor(Schema.Array(Schema.Number));
      const encoded = yield* Schema.encodeEffect(codec)([1, 2, 3]);
      expect(encoded).toStrictEqual({
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 1n },
          { _tag: CborKinds.UInt, num: 2n },
          { _tag: CborKinds.UInt, num: 3n },
        ],
      });
      expect(yield* Schema.decodeEffect(codec)(encoded)).toStrictEqual([1, 2, 3]);
    }),
  );

  it.effect("nested Struct/Array round-trips", () =>
    Effect.gen(function* () {
      const Post = Schema.Struct({
        title: Schema.String,
        likes: Schema.Number,
        tags: Schema.Array(Schema.String),
      });
      const codec = toCodecCbor(Post);
      const value = { title: "hi", likes: 10, tags: ["a", "b"] };
      const encoded = yield* Schema.encodeEffect(codec)(value);
      expect(yield* Schema.decodeEffect(codec)(encoded)).toStrictEqual(value);
    }),
  );

  it.effect("deeply nested", () =>
    Effect.gen(function* () {
      const Schema_ = Schema.Struct({
        a: Schema.Struct({ b: Schema.Array(Schema.Struct({ c: Schema.BigInt })) }),
      });
      const codec = toCodecCbor(Schema_);
      const value = { a: { b: [{ c: 1n }, { c: 2n }] } };
      const encoded = yield* Schema.encodeEffect(codec)(value);
      expect(yield* Schema.decodeEffect(codec)(encoded)).toStrictEqual(value);
    }),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// toCodecCborBytes — composition with CborBytes for end-to-end bytes round-trip
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecCborBytes — bytes round-trip", () => {
  it.effect("String round-trips through Uint8Array", () =>
    Effect.gen(function* () {
      const codec = toCodecCborBytes(Schema.String);
      const bytes = yield* Schema.encodeEffect(codec)("hello");
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(yield* Schema.decodeEffect(codec)(bytes)).toBe("hello");
    }),
  );

  it.effect("Struct round-trips through Uint8Array", () =>
    Effect.gen(function* () {
      const Person = Schema.Struct({ name: Schema.String, age: Schema.Number });
      const codec = toCodecCborBytes(Person);
      const value = { name: "Ada", age: 42 };
      const bytes = yield* Schema.encodeEffect(codec)(value);
      expect(yield* Schema.decodeEffect(codec)(bytes)).toStrictEqual(value);
    }),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Property tests — fast-check over random domain values via Schema.toArbitrary
// ────────────────────────────────────────────────────────────────────────────

describe("toCodecCbor — property tests", () => {
  it.effect.prop(
    "String round-trip",
    [FastCheck.string()],
    ([s]) =>
      Effect.gen(function* () {
        const codec = toCodecCbor(Schema.String);
        const encoded = yield* Schema.encodeEffect(codec)(s);
        const decoded = yield* Schema.decodeEffect(codec)(encoded);
        expect(decoded).toBe(s);
      }),
    { fastCheck: { numRuns: 300 } },
  );

  it.effect.prop(
    "BigInt round-trip across integer and bignum ranges",
    [FastCheck.bigInt({ min: -(1n << 100n), max: 1n << 100n })],
    ([n]) =>
      Effect.gen(function* () {
        const codec = toCodecCbor(Schema.BigInt);
        const encoded = yield* Schema.encodeEffect(codec)(n);
        const decoded = yield* Schema.decodeEffect(codec)(encoded);
        expect(decoded).toBe(n);
      }),
    { fastCheck: { numRuns: 300 } },
  );

  it.effect.prop(
    "Struct round-trip preserves value",
    [
      FastCheck.record({
        name: FastCheck.string(),
        age: FastCheck.integer({ min: 0, max: 150 }),
      }),
    ],
    ([person]) =>
      Effect.gen(function* () {
        const Person = Schema.Struct({ name: Schema.String, age: Schema.Number });
        const codec = toCodecCbor(Person);
        const encoded = yield* Schema.encodeEffect(codec)(person);
        const decoded = yield* Schema.decodeEffect(codec)(encoded);
        expect(decoded).toStrictEqual({ ...person });
      }),
    { fastCheck: { numRuns: 200 } },
  );

  it.effect.prop(
    "Array<Number> round-trip preserves elements",
    [
      FastCheck.array(FastCheck.integer({ min: -1_000_000, max: 1_000_000 }), {
        maxLength: 20,
      }),
    ],
    ([arr]) =>
      Effect.gen(function* () {
        const codec = toCodecCbor(Schema.Array(Schema.Number));
        const encoded = yield* Schema.encodeEffect(codec)(arr);
        const decoded = yield* Schema.decodeEffect(codec)(encoded);
        expect(decoded).toStrictEqual(arr);
      }),
    { fastCheck: { numRuns: 200 } },
  );

  it.effect.prop(
    "toCodecCborBytes round-trip (bytes-level)",
    [
      FastCheck.record({
        n: FastCheck.bigInt({ min: 0n, max: 1n << 40n }),
        s: FastCheck.string(),
      }),
    ],
    ([value]) =>
      Effect.gen(function* () {
        const codec = toCodecCborBytes(Schema.Struct({ n: Schema.BigInt, s: Schema.String }));
        const bytes = yield* Schema.encodeEffect(codec)(value);
        const back = yield* Schema.decodeEffect(codec)(bytes);
        expect(back).toStrictEqual({ ...value });
      }),
    { fastCheck: { numRuns: 150 } },
  );
});
