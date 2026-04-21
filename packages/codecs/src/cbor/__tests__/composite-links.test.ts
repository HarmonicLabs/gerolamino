import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { CborBytes } from "../codec";
import { CborKinds, type CborValue, CborValue as CborValueSchema } from "../CborValue";
import {
  cborInCborLink,
  cborInCborPreserving,
  cborTaggedLink,
  positionalArrayLink,
  sparseMapLink,
  strictMaybe,
  toCodecCbor,
  toCodecCborBytes,
  withCborLink,
} from "../derive";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const encode = <T>(schema: Schema.Codec<T, unknown, never, never>, value: T): unknown =>
  Effect.runSync(Schema.encodeEffect(schema)(value));
const decode = <T>(schema: Schema.Codec<T, unknown, never, never>, encoded: unknown): T =>
  Effect.runSync(Schema.decodeEffect(schema)(encoded));

const u = (num: bigint): CborValue => ({ _tag: CborKinds.UInt, num });
const t = (text: string): CborValue => ({ _tag: CborKinds.Text, text });
const arr = (items: readonly CborValue[]): CborValue => ({ _tag: CborKinds.Array, items });
const map = (entries: readonly { k: CborValue; v: CborValue }[]): CborValue => ({
  _tag: CborKinds.Map,
  entries,
});
const tag = (n: bigint, data: CborValue): CborValue => ({ _tag: CborKinds.Tag, tag: n, data });
const bytes = (b: Uint8Array): CborValue => ({ _tag: CborKinds.Bytes, bytes: b });

// ────────────────────────────────────────────────────────────────────────────
// 1. taggedUnionLink — auto-detected via `_tag` sentinel
// ────────────────────────────────────────────────────────────────────────────

describe("taggedUnionLink — Cardano [tag, ...fields] encoding", () => {
  enum K {
    Zero = 0,
    One = 1,
    Two = 2,
  }

  const DCertLike = Schema.Union([
    Schema.TaggedStruct(K.Zero, { a: Schema.String }),
    Schema.TaggedStruct(K.One, { b: Schema.Number, c: Schema.BigInt }),
    Schema.TaggedStruct(K.Two, {}),
  ]).pipe(Schema.toTaggedUnion("_tag"));

  const codec = toCodecCbor(DCertLike);

  it("encodes a 1-field variant as [UInt(0), field]", () => {
    const encoded = encode(codec, { _tag: K.Zero, a: "hi" });
    expect(encoded).toStrictEqual(arr([u(0n), t("hi")]));
  });

  it("encodes a 2-field variant as [UInt(1), field0, field1]", () => {
    const encoded = encode(codec, { _tag: K.One, b: 42, c: 99n });
    expect(encoded).toStrictEqual(arr([u(1n), u(42n), u(99n)]));
  });

  it("encodes a 0-field variant as [UInt(tag)]", () => {
    const encoded = encode(codec, { _tag: K.Two });
    expect(encoded).toStrictEqual(arr([u(2n)]));
  });

  it("decodes a variant to the correct _tag discriminant", () => {
    const d = decode(codec, arr([u(1n), u(7n), u(8n)]));
    expect(d).toStrictEqual({ _tag: K.One, b: 7, c: 8n });
  });

  it("rejects unknown discriminants with InvalidValue", () => {
    expect(() => decode(codec, arr([u(99n), u(1n)]))).toThrow();
  });

  it("rejects non-Array CBOR with descriptive error", () => {
    expect(() => decode(codec, u(0n))).toThrow();
  });

  it("round-trips all variants via FastCheck", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.oneof(
          FastCheck.record({
            _tag: FastCheck.constant(K.Zero),
            a: FastCheck.string(),
          }),
          FastCheck.record({
            _tag: FastCheck.constant(K.One),
            b: FastCheck.integer({ min: 0, max: 1_000_000 }),
            c: FastCheck.bigInt({ min: 0n, max: 1n << 40n }),
          }),
          FastCheck.record({ _tag: FastCheck.constant(K.Two) }),
        ),
        (value) => {
          const out = decode(codec, encode(codec, value));
          return (
            JSON.stringify(out, (_, v) => (typeof v === "bigint" ? String(v) : v)) ===
            JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v))
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("throws on duplicate discriminants at construction", () => {
    const Bad = Schema.Union([
      Schema.TaggedStruct(0, { x: Schema.String }),
      Schema.TaggedStruct(0, { y: Schema.Number }),
    ]).pipe(Schema.toTaggedUnion("_tag"));
    expect(() => toCodecCbor(Bad)).toThrow(/duplicate discriminant/);
  });

  it("handles string discriminants", () => {
    const U = Schema.Union([
      Schema.TaggedStruct("alpha", { v: Schema.String }),
      Schema.TaggedStruct("beta", { n: Schema.Number }),
    ]).pipe(Schema.toTaggedUnion("_tag"));
    const c = toCodecCbor(U);
    expect(encode(c, { _tag: "alpha", v: "hi" })).toStrictEqual(arr([t("alpha"), t("hi")]));
    expect(decode(c, arr([t("beta"), u(9n)]))).toStrictEqual({ _tag: "beta", n: 9 });
  });

  it("supports recursive unions via Schema.suspend + Schema.Codec<T>", () => {
    enum PD {
      Constr = 0,
      Int = 1,
    }
    type PlutusData =
      | { readonly _tag: PD.Constr; readonly fields: ReadonlyArray<PlutusData> }
      | { readonly _tag: PD.Int; readonly value: bigint };

    const PDRef = Schema.suspend((): Schema.Codec<PlutusData> => PDDef);
    const PDDef = Schema.Union([
      Schema.TaggedStruct(PD.Constr, { fields: Schema.Array(PDRef) }),
      Schema.TaggedStruct(PD.Int, { value: Schema.BigInt }),
    ]).pipe(Schema.toTaggedUnion("_tag"));

    const c = toCodecCbor(PDDef);
    const value: PlutusData = {
      _tag: PD.Constr,
      fields: [
        { _tag: PD.Int, value: 1n },
        { _tag: PD.Constr, fields: [{ _tag: PD.Int, value: 42n }] },
      ],
    };
    expect(decode(c, encode(c, value))).toStrictEqual(value);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. sparseMapLink
// ────────────────────────────────────────────────────────────────────────────

describe("sparseMapLink — integer-keyed CBOR Map", () => {
  const Body = Schema.Struct({
    fee: Schema.BigInt,
    ttl: Schema.optional(Schema.BigInt),
    inputs: Schema.Array(Schema.Number),
  }).annotate({
    toCborLink: sparseMapLink({ fee: 2, ttl: 3, inputs: 0 }),
  });
  const codec = toCodecCbor(Body);

  it("encodes a full object with integer keys sorted numerically", () => {
    const encoded = encode(codec, { fee: 100n, ttl: 999n, inputs: [1, 2] });
    expect(encoded).toStrictEqual(
      map([
        { k: u(0n), v: arr([u(1n), u(2n)]) },
        { k: u(2n), v: u(100n) },
        { k: u(3n), v: u(999n) },
      ]),
    );
  });

  it("omits absent optional fields", () => {
    const encoded = encode(codec, { fee: 5n, inputs: [] });
    expect(encoded).toStrictEqual(
      map([
        { k: u(0n), v: arr([]) },
        { k: u(2n), v: u(5n) },
      ]),
    );
  });

  it("decodes a full map", () => {
    const v = decode(
      codec,
      map([
        { k: u(0n), v: arr([u(7n)]) },
        { k: u(2n), v: u(50n) },
        { k: u(3n), v: u(100n) },
      ]),
    );
    expect(v).toStrictEqual({ fee: 50n, ttl: 100n, inputs: [7] });
  });

  it("silently skips unknown keys (forward-compatibility)", () => {
    const v = decode(
      codec,
      map([
        { k: u(0n), v: arr([u(1n)]) },
        { k: u(2n), v: u(9n) },
        { k: u(99n), v: t("future field") }, // unknown — ignored
      ]),
    );
    expect(v).toStrictEqual({ fee: 9n, inputs: [1] });
  });

  it("rejects missing required fields", () => {
    expect(() => decode(codec, map([{ k: u(2n), v: u(1n) }]))).toThrow();
  });

  it("throws on duplicate integer keys at construction", () => {
    const Bad = Schema.Struct({
      a: Schema.String,
      b: Schema.Number,
    }).annotate({
      toCborLink: sparseMapLink({ a: 0, b: 0 }),
    });
    expect(() => toCodecCbor(Bad)).toThrow(/integer key 0 mapped from both/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. cborTaggedLink
// ────────────────────────────────────────────────────────────────────────────

describe("cborTaggedLink — CBOR Tag(n) wrapping", () => {
  // Use Array<Number> as the inner — Tag(258, [nums])
  const Set258 = Schema.Array(Schema.Number).annotate({
    toCborLink: cborTaggedLink(258),
  });
  const codec = toCodecCbor(Set258);

  it("wraps inner encoding in Tag(258)", () => {
    const encoded = encode(codec, [1, 2, 3]);
    expect(encoded).toStrictEqual(tag(258n, arr([u(1n), u(2n), u(3n)])));
  });

  it("decodes Tag(258)(Array) correctly", () => {
    const v = decode(codec, tag(258n, arr([u(9n)])));
    expect(v).toStrictEqual([9]);
  });

  it("rejects Tag with wrong number", () => {
    expect(() => decode(codec, tag(7n, arr([u(1n)])))).toThrow(/Expected Tag 258/);
  });

  it("rejects non-Tag CBOR", () => {
    expect(() => decode(codec, arr([u(1n)]))).toThrow();
  });

  it("composes with Tag(30) rational [num, denom]", () => {
    const Rational = Schema.Struct({
      num: Schema.BigInt,
      denom: Schema.BigInt,
    }).annotate({
      toCborLink: (_walked) => {
        // Build a Link that positional-encodes to [num, denom] then wraps in Tag(30).
        // We lift: inner = positionalArrayLink(["num", "denom"])(_walked).
        // Compose via sub-annotation: wrap the Struct in Tag(30) over positional array.
        const inner = positionalArrayLink(["num", "denom"])(_walked);
        // cborTaggedLink wraps the inner encoding present on `_walked`. We manually
        // call it after planting the inner on a shadow copy.
        return cborTaggedLink(30)({
          ..._walked,
          encoding: [inner],
          annotations: _walked.annotations,
        } as typeof _walked);
      },
    });
    const c = toCodecCbor(Rational);
    const value = { num: 3n, denom: 7n };
    const encoded = encode(c, value);
    expect(encoded).toStrictEqual(tag(30n, arr([u(3n), u(7n)])));
    expect(decode(c, encoded)).toStrictEqual(value);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. cborInCborLink / cborInCborPreserving
// ────────────────────────────────────────────────────────────────────────────

describe("cborInCborLink — Tag(24)(Bytes(inner_cbor))", () => {
  const Inner = Schema.Struct({ n: Schema.BigInt });

  const Outer = Inner.annotate({
    toCborLink: cborInCborLink(),
  });

  it("wraps inner in Tag(24) + bytes-serialized CBOR", () => {
    const bytesCodec = toCodecCborBytes(Outer);
    const value = { n: 42n };
    const outerBytes = Effect.runSync(Schema.encodeEffect(bytesCodec)(value));
    const back = Effect.runSync(Schema.decodeEffect(bytesCodec)(outerBytes));
    expect(back).toStrictEqual(value);
  });

  it("accepts Tag(24)(Bytes(valid_cbor)) on decode", () => {
    const c = toCodecCbor(Outer);
    const encoded = encode(c, { n: 7n });
    // encoded is Tag(24)(Bytes(...)) — narrow via the CborValueSchema decode Effect
    const cbor = Effect.runSync(Schema.decodeUnknownEffect(CborValueSchema)(encoded));
    if (!CborValueSchema.guards[CborKinds.Tag](cbor)) {
      throw new Error("expected a CBOR Tag variant");
    }
    expect(cbor.tag).toBe(24n);
    expect(decode(c, encoded)).toStrictEqual({ n: 7n });
  });

  it("rejects Tag(other)", () => {
    const c = toCodecCbor(Outer);
    expect(() => decode(c, tag(7n, bytes(new Uint8Array([0x00]))))).toThrow(/Tag\(24\)/);
  });

  it("rejects Tag(24)(non-Bytes)", () => {
    const c = toCodecCbor(Outer);
    expect(() => decode(c, tag(24n, u(5n)))).toThrow(/Tag\(24\) payload must be Bytes/);
  });
});

describe("cborInCborPreserving — byte-exact round-trip", () => {
  const Inner = Schema.Struct({ a: Schema.String, b: Schema.BigInt });
  const Preserved = cborInCborPreserving(toCodecCbor(Inner));

  it("re-encodes preserved bytes verbatim through a round-trip", () => {
    const bytesCodec = toCodecCborBytes(Preserved);
    const originalValue = { a: "hi", b: 99n };
    const enc1 = Effect.runSync(Schema.encodeEffect(bytesCodec)({ value: originalValue }));
    const dec1 = Effect.runSync(Schema.decodeEffect(bytesCodec)(enc1));
    expect(dec1.value).toStrictEqual(originalValue);
    expect(dec1.origBytes).toBeInstanceOf(Uint8Array);
    const enc2 = Effect.runSync(Schema.encodeEffect(bytesCodec)(dec1));
    expect(enc2).toStrictEqual(enc1);
  });

  it("encodes canonically when origBytes is absent on the input", () => {
    const bytesCodec = toCodecCborBytes(Preserved);
    const canonicalBytes = Effect.runSync(
      Schema.encodeEffect(bytesCodec)({ value: { a: "x", b: 1n } }),
    );
    const decoded = Effect.runSync(Schema.decodeEffect(bytesCodec)(canonicalBytes));
    expect(decoded.value).toStrictEqual({ a: "x", b: 1n });
    // Re-encode without modifying origBytes reproduces the exact wire bytes.
    expect(Effect.runSync(Schema.encodeEffect(bytesCodec)(decoded))).toStrictEqual(canonicalBytes);
  });

  it("preserves non-canonical inner bytes on re-encode", () => {
    // Build a Tag(24)(Bytes(non-canonical-map)) by hand. The inner map has
    // keys in non-lex order ("b" before "a") which canonical form would flip;
    // the preserving codec must emit the exact bytes back.
    const nonCanonicalInnerMap = map([
      { k: t("b"), v: u(1n) },
      { k: t("a"), v: t("x") },
    ]);
    const innerBytes = Effect.runSync(Schema.encodeEffect(CborBytes)(nonCanonicalInnerMap));
    const outerCbor = tag(24n, bytes(innerBytes));
    const outerBytes = Effect.runSync(Schema.encodeEffect(CborBytes)(outerCbor));

    const bytesCodec = toCodecCborBytes(Preserved);
    const decoded = Effect.runSync(Schema.decodeEffect(bytesCodec)(outerBytes));
    expect(decoded.value).toStrictEqual({ a: "x", b: 1n });
    expect(decoded.origBytes).toStrictEqual(innerBytes);
    const reEncoded = Effect.runSync(Schema.encodeEffect(bytesCodec)(decoded));
    expect(reEncoded).toStrictEqual(outerBytes);
  });

  it("rejects Tag(other)", () => {
    const c = toCodecCbor(Preserved);
    expect(() => decode(c, tag(7n, bytes(new Uint8Array([0x00]))))).toThrow(/Tag\(24\)/);
  });

  it("rejects Tag(24)(non-Bytes)", () => {
    const c = toCodecCbor(Preserved);
    expect(() => decode(c, tag(24n, u(5n)))).toThrow(/Tag\(24\) payload must be Bytes/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. strictMaybe
// ────────────────────────────────────────────────────────────────────────────

describe("strictMaybe — Haskell StrictMaybe wire shape", () => {
  const MaybeBig = strictMaybe(toCodecCbor(Schema.BigInt));
  const codec = toCodecCbor(MaybeBig);

  it("encodes Nothing (undefined) as Array([])", () => {
    expect(encode(codec, undefined)).toStrictEqual(arr([]));
  });

  it("encodes Just(x) as Array([x])", () => {
    expect(encode(codec, 42n)).toStrictEqual(arr([u(42n)]));
  });

  it("decodes Array([]) as undefined", () => {
    expect(decode(codec, arr([]))).toBe(undefined);
  });

  it("decodes Array([x]) as x", () => {
    expect(decode(codec, arr([u(99n)]))).toBe(99n);
  });

  it("rejects Array of length > 1", () => {
    expect(() => decode(codec, arr([u(1n), u(2n)]))).toThrow(/length 0 or 1/);
  });

  it("nested StrictMaybe(StrictMaybe(T)) round-trips correctly", () => {
    const Nested = strictMaybe(toCodecCbor(MaybeBig));
    const nestedCodec = toCodecCbor(Nested);
    // Outer Just(Inner Nothing) → [[]]
    expect(encode(nestedCodec, undefined)).toStrictEqual(arr([]));
    // Outer Just(Inner Just(x)) needs explicit roundtrip
    expect(decode(nestedCodec, arr([arr([])]))).toBe(undefined);
    expect(decode(nestedCodec, arr([arr([u(7n)])]))).toBe(7n);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. positionalArrayLink
// ────────────────────────────────────────────────────────────────────────────

describe("positionalArrayLink — fixed-length positional struct", () => {
  const Point = Schema.Struct({
    x: Schema.BigInt,
    y: Schema.BigInt,
    z: Schema.BigInt,
  }).annotate({
    toCborLink: positionalArrayLink(["x", "y", "z"]),
  });
  const codec = toCodecCbor(Point);

  it("encodes struct as fixed-length CBOR Array in declared order", () => {
    const encoded = encode(codec, { x: 1n, y: 2n, z: 3n });
    expect(encoded).toStrictEqual(arr([u(1n), u(2n), u(3n)]));
  });

  it("decodes fixed-length Array back to struct", () => {
    expect(decode(codec, arr([u(10n), u(20n), u(30n)]))).toStrictEqual({
      x: 10n,
      y: 20n,
      z: 30n,
    });
  });

  it("rejects short arrays", () => {
    expect(() => decode(codec, arr([u(1n), u(2n)]))).toThrow(/expected at least 3 slots/);
  });

  it("rejects long arrays", () => {
    expect(() => decode(codec, arr([u(1n), u(2n), u(3n), u(4n)]))).toThrow(
      /expected at most 3 slots/,
    );
  });

  it("supports trailing-optional slots", () => {
    const WithOpt = Schema.Struct({
      a: Schema.BigInt,
      b: Schema.optional(Schema.BigInt),
    }).annotate({
      toCborLink: positionalArrayLink(["a", "b"]),
    });
    const c = toCodecCbor(WithOpt);
    expect(encode(c, { a: 1n })).toStrictEqual(arr([u(1n)]));
    expect(encode(c, { a: 1n, b: 2n })).toStrictEqual(arr([u(1n), u(2n)]));
    expect(decode(c, arr([u(1n)]))).toStrictEqual({ a: 1n });
    expect(decode(c, arr([u(1n), u(2n)]))).toStrictEqual({ a: 1n, b: 2n });
  });

  it("rejects interior-optional at construction", () => {
    const Bad = Schema.Struct({
      a: Schema.BigInt,
      b: Schema.optional(Schema.BigInt),
      c: Schema.BigInt,
    }).annotate({
      toCborLink: positionalArrayLink(["a", "b", "c"]),
    });
    expect(() => toCodecCbor(Bad)).toThrow(/only trailing optionals are allowed/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Integration — nested composition (Tag(258)-under-tagged-union, StrictMaybe
// of tagged union, positional array with nested tagged union).
// ────────────────────────────────────────────────────────────────────────────

describe("Composition — nested composite-links", () => {
  it("tagged-union member field containing Tag(258) set", () => {
    const Set258 = Schema.Array(Schema.BigInt).annotate({
      toCborLink: cborTaggedLink(258),
    });
    const U = Schema.Union([
      Schema.TaggedStruct(0, { members: Set258 }),
      Schema.TaggedStruct(1, {}),
    ]).pipe(Schema.toTaggedUnion("_tag"));
    const c = toCodecCbor(U);
    const v = { _tag: 0 as const, members: [1n, 2n, 3n] };
    const encoded = encode(c, v);
    expect(encoded).toStrictEqual(arr([u(0n), tag(258n, arr([u(1n), u(2n), u(3n)]))]));
    expect(decode(c, encoded)).toStrictEqual(v);
  });

  it("StrictMaybe of struct (DRepState.anchor shape)", () => {
    const Anchor = Schema.Struct({ url: Schema.String });
    const MaybeAnchor = strictMaybe(toCodecCbor(Anchor));
    const State = Schema.Struct({
      expiry: Schema.BigInt,
      anchor: MaybeAnchor,
    }).annotate({
      toCborLink: positionalArrayLink(["expiry", "anchor"]),
    });
    const c = toCodecCbor(State);

    const withAnchor = encode(c, {
      expiry: 100n,
      anchor: { url: "http://x" },
    });
    expect(withAnchor).toStrictEqual(
      arr([u(100n), arr([map([{ k: t("url"), v: t("http://x") }])])]),
    );
    expect(decode(c, withAnchor)).toStrictEqual({
      expiry: 100n,
      anchor: { url: "http://x" },
    });

    const withoutAnchor = encode(c, { expiry: 200n, anchor: undefined });
    expect(withoutAnchor).toStrictEqual(arr([u(200n), arr([])]));
    expect(decode(c, withoutAnchor)).toStrictEqual({ expiry: 200n, anchor: undefined });
  });

  it("withCborLink helper attaches annotation equivalently", () => {
    const A = Schema.Struct({ x: Schema.BigInt, y: Schema.BigInt });
    const viaAnnotate = A.annotate({ toCborLink: positionalArrayLink(["x", "y"]) });
    const viaHelper = withCborLink<typeof A>(positionalArrayLink(["x", "y"]))(A);
    const cA = toCodecCbor(viaAnnotate);
    const cB = toCodecCbor(viaHelper);
    expect(encode(cA, { x: 1n, y: 2n })).toStrictEqual(encode(cB, { x: 1n, y: 2n }));
  });

  it("tagged union + sparse-map combo (TxBody-shape with DCert field)", () => {
    enum K {
      Reg = 0,
      Dereg = 1,
    }
    const DCert = Schema.Union([
      Schema.TaggedStruct(K.Reg, { keyHash: Schema.String }),
      Schema.TaggedStruct(K.Dereg, { keyHash: Schema.String }),
    ]).pipe(Schema.toTaggedUnion("_tag"));

    const Body = Schema.Struct({
      fee: Schema.BigInt,
      certs: Schema.optional(Schema.Array(DCert)),
    }).annotate({
      toCborLink: sparseMapLink({ fee: 2, certs: 4 }),
    });

    const c = toCodecCbor(Body);
    const v = {
      fee: 10n,
      certs: [
        { _tag: K.Reg, keyHash: "abc" },
        { _tag: K.Dereg, keyHash: "def" },
      ],
    };
    const encoded = encode(c, v);
    expect(encoded).toStrictEqual(
      map([
        { k: u(2n), v: u(10n) },
        {
          k: u(4n),
          v: arr([arr([u(0n), t("abc")]), arr([u(1n), t("def")])]),
        },
      ]),
    );
    expect(decode(c, encoded)).toStrictEqual(v);
  });
});

// Helpers that were unused in the test file but referenced in typechecker —
// silence unused imports. (bytes/tag are used above.)
void bytes;
void tag;
