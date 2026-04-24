import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Equal, Exit, Schema } from "effect";
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

const u = (num: bigint): CborValue => ({ _tag: CborKinds.UInt, num });
const t = (text: string): CborValue => ({ _tag: CborKinds.Text, text });
const arr = (items: readonly CborValue[]): CborValue => ({ _tag: CborKinds.Array, items });
const map = (entries: readonly { k: CborValue; v: CborValue }[]): CborValue => ({
  _tag: CborKinds.Map,
  entries,
});
const tag = (n: bigint, data: CborValue): CborValue => ({ _tag: CborKinds.Tag, tag: n, data });
const bytes = (b: Uint8Array): CborValue => ({ _tag: CborKinds.Bytes, bytes: b });

const expectDecodeFailure = <T>(
  codec: Schema.Codec<T, unknown, never, never>,
  encoded: unknown,
  pattern?: RegExp,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(Schema.decodeEffect(codec)(encoded));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && pattern) {
      expect(Cause.pretty(exit.cause)).toMatch(pattern);
    }
  });

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

  it.effect("encodes a 1-field variant as [UInt(0), field]", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(codec)({ _tag: K.Zero, a: "hi" });
      expect(encoded).toStrictEqual(arr([u(0n), t("hi")]));
    }),
  );

  it.effect("encodes a 2-field variant as [UInt(1), field0, field1]", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(codec)({ _tag: K.One, b: 42, c: 99n });
      expect(encoded).toStrictEqual(arr([u(1n), u(42n), u(99n)]));
    }),
  );

  it.effect("encodes a 0-field variant as [UInt(tag)]", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(codec)({ _tag: K.Two });
      expect(encoded).toStrictEqual(arr([u(2n)]));
    }),
  );

  it.effect("decodes a variant to the correct _tag discriminant", () =>
    Effect.gen(function* () {
      const d = yield* Schema.decodeEffect(codec)(arr([u(1n), u(7n), u(8n)]));
      expect(d).toStrictEqual({ _tag: K.One, b: 7, c: 8n });
    }),
  );

  it.effect("rejects unknown discriminants with InvalidValue", () =>
    expectDecodeFailure(codec, arr([u(99n), u(1n)])),
  );

  it.effect("rejects non-Array CBOR with descriptive error", () =>
    expectDecodeFailure(codec, u(0n)),
  );

  it.effect.prop(
    "round-trips all variants via FastCheck",
    [
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
    ],
    ([value]) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(codec)(value);
        const decoded = yield* Schema.decodeEffect(codec)(encoded);
        expect(Equal.equals(decoded, value)).toBe(true);
      }),
    { fastCheck: { numRuns: 200 } },
  );

  it("throws on duplicate discriminants at construction", () => {
    const Bad = Schema.Union([
      Schema.TaggedStruct(0, { x: Schema.String }),
      Schema.TaggedStruct(0, { y: Schema.Number }),
    ]).pipe(Schema.toTaggedUnion("_tag"));
    expect(() => toCodecCbor(Bad)).toThrow(/duplicate discriminant/);
  });

  it.effect("handles string discriminants", () =>
    Effect.gen(function* () {
      const U = Schema.Union([
        Schema.TaggedStruct("alpha", { v: Schema.String }),
        Schema.TaggedStruct("beta", { n: Schema.Number }),
      ]).pipe(Schema.toTaggedUnion("_tag"));
      const c = toCodecCbor(U);
      const encoded = yield* Schema.encodeEffect(c)({ _tag: "alpha", v: "hi" });
      expect(encoded).toStrictEqual(arr([t("alpha"), t("hi")]));
      const decoded = yield* Schema.decodeEffect(c)(arr([t("beta"), u(9n)]));
      expect(decoded).toStrictEqual({ _tag: "beta", n: 9 });
    }),
  );

  it.effect("supports recursive unions via Schema.suspend + Schema.Codec<T>", () =>
    Effect.gen(function* () {
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
      const encoded = yield* Schema.encodeEffect(c)(value);
      const decoded = yield* Schema.decodeEffect(c)(encoded);
      expect(decoded).toStrictEqual(value);
    }),
  );
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

  it.effect("encodes a full object with integer keys sorted numerically", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(codec)({ fee: 100n, ttl: 999n, inputs: [1, 2] });
      expect(encoded).toStrictEqual(
        map([
          { k: u(0n), v: arr([u(1n), u(2n)]) },
          { k: u(2n), v: u(100n) },
          { k: u(3n), v: u(999n) },
        ]),
      );
    }),
  );

  it.effect("omits absent optional fields", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(codec)({ fee: 5n, inputs: [] });
      expect(encoded).toStrictEqual(
        map([
          { k: u(0n), v: arr([]) },
          { k: u(2n), v: u(5n) },
        ]),
      );
    }),
  );

  it.effect("decodes a full map", () =>
    Effect.gen(function* () {
      const v = yield* Schema.decodeEffect(codec)(
        map([
          { k: u(0n), v: arr([u(7n)]) },
          { k: u(2n), v: u(50n) },
          { k: u(3n), v: u(100n) },
        ]),
      );
      expect(v).toStrictEqual({ fee: 50n, ttl: 100n, inputs: [7] });
    }),
  );

  it.effect("silently skips unknown keys (forward-compatibility)", () =>
    Effect.gen(function* () {
      const v = yield* Schema.decodeEffect(codec)(
        map([
          { k: u(0n), v: arr([u(1n)]) },
          { k: u(2n), v: u(9n) },
          { k: u(99n), v: t("future field") },
        ]),
      );
      expect(v).toStrictEqual({ fee: 9n, inputs: [1] });
    }),
  );

  it.effect("rejects missing required fields", () =>
    expectDecodeFailure(codec, map([{ k: u(2n), v: u(1n) }])),
  );

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
  const Set258 = Schema.Array(Schema.Number).annotate({
    toCborLink: cborTaggedLink(258),
  });
  const codec = toCodecCbor(Set258);

  it.effect("wraps inner encoding in Tag(258)", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(codec)([1, 2, 3]);
      expect(encoded).toStrictEqual(tag(258n, arr([u(1n), u(2n), u(3n)])));
    }),
  );

  it.effect("decodes Tag(258)(Array) correctly", () =>
    Effect.gen(function* () {
      const v = yield* Schema.decodeEffect(codec)(tag(258n, arr([u(9n)])));
      expect(v).toStrictEqual([9]);
    }),
  );

  it.effect("rejects Tag with wrong number", () =>
    expectDecodeFailure(codec, tag(7n, arr([u(1n)])), /Expected Tag 258/),
  );

  it.effect("rejects non-Tag CBOR", () => expectDecodeFailure(codec, arr([u(1n)])));

  it.effect("composes with Tag(30) rational [num, denom]", () =>
    Effect.gen(function* () {
      const Rational = Schema.Struct({
        num: Schema.BigInt,
        denom: Schema.BigInt,
      }).annotate({
        toCborLink: (_walked) => {
          const inner = positionalArrayLink(["num", "denom"])(_walked);
          return cborTaggedLink(30)({
            ..._walked,
            encoding: [inner],
            annotations: _walked.annotations,
          } as typeof _walked);
        },
      });
      const c = toCodecCbor(Rational);
      const value = { num: 3n, denom: 7n };
      const encoded = yield* Schema.encodeEffect(c)(value);
      expect(encoded).toStrictEqual(tag(30n, arr([u(3n), u(7n)])));
      const decoded = yield* Schema.decodeEffect(c)(encoded);
      expect(decoded).toStrictEqual(value);
    }),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 4. cborInCborLink / cborInCborPreserving
// ────────────────────────────────────────────────────────────────────────────

describe("cborInCborLink — Tag(24)(Bytes(inner_cbor))", () => {
  const Inner = Schema.Struct({ n: Schema.BigInt });

  const Outer = Inner.annotate({
    toCborLink: cborInCborLink(),
  });

  it.effect("wraps inner in Tag(24) + bytes-serialized CBOR", () =>
    Effect.gen(function* () {
      const bytesCodec = toCodecCborBytes(Outer);
      const value = { n: 42n };
      const outerBytes = yield* Schema.encodeEffect(bytesCodec)(value);
      const back = yield* Schema.decodeEffect(bytesCodec)(outerBytes);
      expect(back).toStrictEqual(value);
    }),
  );

  it.effect("accepts Tag(24)(Bytes(valid_cbor)) on decode", () =>
    Effect.gen(function* () {
      const c = toCodecCbor(Outer);
      const encoded = yield* Schema.encodeEffect(c)({ n: 7n });
      const cbor = yield* Schema.decodeUnknownEffect(CborValueSchema)(encoded);
      if (!CborValueSchema.guards[CborKinds.Tag](cbor)) {
        throw new Error("expected a CBOR Tag variant");
      }
      expect(cbor.tag).toBe(24n);
      const decoded = yield* Schema.decodeEffect(c)(encoded);
      expect(decoded).toStrictEqual({ n: 7n });
    }),
  );

  it.effect("rejects Tag(other)", () =>
    expectDecodeFailure(toCodecCbor(Outer), tag(7n, bytes(new Uint8Array([0x00]))), /Tag\(24\)/),
  );

  it.effect("rejects Tag(24)(non-Bytes)", () =>
    expectDecodeFailure(toCodecCbor(Outer), tag(24n, u(5n)), /Tag\(24\) payload must be Bytes/),
  );
});

describe("cborInCborPreserving — byte-exact round-trip", () => {
  const Inner = Schema.Struct({ a: Schema.String, b: Schema.BigInt });
  const Preserved = cborInCborPreserving(toCodecCbor(Inner));

  it.effect("re-encodes preserved bytes verbatim through a round-trip", () =>
    Effect.gen(function* () {
      const bytesCodec = toCodecCborBytes(Preserved);
      const originalValue = { a: "hi", b: 99n };
      const enc1 = yield* Schema.encodeEffect(bytesCodec)({ value: originalValue });
      const dec1 = yield* Schema.decodeEffect(bytesCodec)(enc1);
      expect(dec1.value).toStrictEqual(originalValue);
      expect(dec1.origBytes).toBeInstanceOf(Uint8Array);
      const enc2 = yield* Schema.encodeEffect(bytesCodec)(dec1);
      expect(enc2).toStrictEqual(enc1);
    }),
  );

  it.effect("encodes canonically when origBytes is absent on the input", () =>
    Effect.gen(function* () {
      const bytesCodec = toCodecCborBytes(Preserved);
      const canonicalBytes = yield* Schema.encodeEffect(bytesCodec)({
        value: { a: "x", b: 1n },
      });
      const decoded = yield* Schema.decodeEffect(bytesCodec)(canonicalBytes);
      expect(decoded.value).toStrictEqual({ a: "x", b: 1n });
      const reEncoded = yield* Schema.encodeEffect(bytesCodec)(decoded);
      expect(reEncoded).toStrictEqual(canonicalBytes);
    }),
  );

  it.effect("preserves non-canonical inner bytes on re-encode", () =>
    Effect.gen(function* () {
      const nonCanonicalInnerMap = map([
        { k: t("b"), v: u(1n) },
        { k: t("a"), v: t("x") },
      ]);
      const innerBytes = yield* Schema.encodeEffect(CborBytes)(nonCanonicalInnerMap);
      const outerCbor = tag(24n, bytes(innerBytes));
      const outerBytes = yield* Schema.encodeEffect(CborBytes)(outerCbor);

      const bytesCodec = toCodecCborBytes(Preserved);
      const decoded = yield* Schema.decodeEffect(bytesCodec)(outerBytes);
      expect(decoded.value).toStrictEqual({ a: "x", b: 1n });
      expect(decoded.origBytes).toStrictEqual(innerBytes);
      const reEncoded = yield* Schema.encodeEffect(bytesCodec)(decoded);
      expect(reEncoded).toStrictEqual(outerBytes);
    }),
  );

  it.effect("rejects Tag(other) [Preserved]", () =>
    expectDecodeFailure(
      toCodecCbor(Preserved),
      tag(7n, bytes(new Uint8Array([0x00]))),
      /Tag\(24\)/,
    ),
  );

  it.effect("rejects Tag(24)(non-Bytes) [Preserved]", () =>
    expectDecodeFailure(toCodecCbor(Preserved), tag(24n, u(5n)), /Tag\(24\) payload must be Bytes/),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 5. strictMaybe
// ────────────────────────────────────────────────────────────────────────────

describe("strictMaybe — Haskell StrictMaybe wire shape", () => {
  const MaybeBig = strictMaybe(toCodecCbor(Schema.BigInt));
  const codec = toCodecCbor(MaybeBig);

  it.effect("encodes Nothing (undefined) as Array([])", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(codec)(undefined);
      expect(encoded).toStrictEqual(arr([]));
    }),
  );

  it.effect("encodes Just(x) as Array([x])", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(codec)(42n);
      expect(encoded).toStrictEqual(arr([u(42n)]));
    }),
  );

  it.effect("decodes Array([]) as undefined", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeEffect(codec)(arr([]));
      expect(decoded).toBe(undefined);
    }),
  );

  it.effect("decodes Array([x]) as x", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeEffect(codec)(arr([u(99n)]));
      expect(decoded).toBe(99n);
    }),
  );

  it.effect("rejects Array of length > 1", () =>
    expectDecodeFailure(codec, arr([u(1n), u(2n)]), /length 0 or 1/),
  );

  it.effect("nested StrictMaybe(StrictMaybe(T)) round-trips correctly", () =>
    Effect.gen(function* () {
      const Nested = strictMaybe(toCodecCbor(MaybeBig));
      const nestedCodec = toCodecCbor(Nested);
      const outerNothing = yield* Schema.encodeEffect(nestedCodec)(undefined);
      expect(outerNothing).toStrictEqual(arr([]));
      expect(yield* Schema.decodeEffect(nestedCodec)(arr([arr([])]))).toBe(undefined);
      expect(yield* Schema.decodeEffect(nestedCodec)(arr([arr([u(7n)])]))).toBe(7n);
    }),
  );
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

  it.effect("encodes struct as fixed-length CBOR Array in declared order", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(codec)({ x: 1n, y: 2n, z: 3n });
      expect(encoded).toStrictEqual(arr([u(1n), u(2n), u(3n)]));
    }),
  );

  it.effect("decodes fixed-length Array back to struct", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeEffect(codec)(arr([u(10n), u(20n), u(30n)]));
      expect(decoded).toStrictEqual({ x: 10n, y: 20n, z: 30n });
    }),
  );

  it.effect("rejects short arrays", () =>
    expectDecodeFailure(codec, arr([u(1n), u(2n)]), /expected at least 3 slots/),
  );

  it.effect("rejects long arrays", () =>
    expectDecodeFailure(codec, arr([u(1n), u(2n), u(3n), u(4n)]), /expected at most 3 slots/),
  );

  it.effect("supports trailing-optional slots", () =>
    Effect.gen(function* () {
      const WithOpt = Schema.Struct({
        a: Schema.BigInt,
        b: Schema.optional(Schema.BigInt),
      }).annotate({
        toCborLink: positionalArrayLink(["a", "b"]),
      });
      const c = toCodecCbor(WithOpt);
      expect(yield* Schema.encodeEffect(c)({ a: 1n })).toStrictEqual(arr([u(1n)]));
      expect(yield* Schema.encodeEffect(c)({ a: 1n, b: 2n })).toStrictEqual(arr([u(1n), u(2n)]));
      expect(yield* Schema.decodeEffect(c)(arr([u(1n)]))).toStrictEqual({ a: 1n });
      expect(yield* Schema.decodeEffect(c)(arr([u(1n), u(2n)]))).toStrictEqual({
        a: 1n,
        b: 2n,
      });
    }),
  );

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
// Integration — nested composition
// ────────────────────────────────────────────────────────────────────────────

describe("Composition — nested composite-links", () => {
  it.effect("tagged-union member field containing Tag(258) set", () =>
    Effect.gen(function* () {
      const Set258 = Schema.Array(Schema.BigInt).annotate({
        toCborLink: cborTaggedLink(258),
      });
      const U = Schema.Union([
        Schema.TaggedStruct(0, { members: Set258 }),
        Schema.TaggedStruct(1, {}),
      ]).pipe(Schema.toTaggedUnion("_tag"));
      const c = toCodecCbor(U);
      const v = { _tag: 0 as const, members: [1n, 2n, 3n] };
      const encoded = yield* Schema.encodeEffect(c)(v);
      expect(encoded).toStrictEqual(arr([u(0n), tag(258n, arr([u(1n), u(2n), u(3n)]))]));
      const decoded = yield* Schema.decodeEffect(c)(encoded);
      expect(decoded).toStrictEqual(v);
    }),
  );

  it.effect("StrictMaybe of struct (DRepState.anchor shape)", () =>
    Effect.gen(function* () {
      const Anchor = Schema.Struct({ url: Schema.String });
      const MaybeAnchor = strictMaybe(toCodecCbor(Anchor));
      const State = Schema.Struct({
        expiry: Schema.BigInt,
        anchor: MaybeAnchor,
      }).annotate({
        toCborLink: positionalArrayLink(["expiry", "anchor"]),
      });
      const c = toCodecCbor(State);

      const withAnchor = yield* Schema.encodeEffect(c)({
        expiry: 100n,
        anchor: { url: "http://x" },
      });
      expect(withAnchor).toStrictEqual(
        arr([u(100n), arr([map([{ k: t("url"), v: t("http://x") }])])]),
      );
      expect(yield* Schema.decodeEffect(c)(withAnchor)).toStrictEqual({
        expiry: 100n,
        anchor: { url: "http://x" },
      });

      const withoutAnchor = yield* Schema.encodeEffect(c)({ expiry: 200n, anchor: undefined });
      expect(withoutAnchor).toStrictEqual(arr([u(200n), arr([])]));
      expect(yield* Schema.decodeEffect(c)(withoutAnchor)).toStrictEqual({
        expiry: 200n,
        anchor: undefined,
      });
    }),
  );

  it.effect("withCborLink helper attaches annotation equivalently", () =>
    Effect.gen(function* () {
      const A = Schema.Struct({ x: Schema.BigInt, y: Schema.BigInt });
      const viaAnnotate = A.annotate({ toCborLink: positionalArrayLink(["x", "y"]) });
      const viaHelper = withCborLink<typeof A>(positionalArrayLink(["x", "y"]))(A);
      const cA = toCodecCbor(viaAnnotate);
      const cB = toCodecCbor(viaHelper);
      const encA = yield* Schema.encodeEffect(cA)({ x: 1n, y: 2n });
      const encB = yield* Schema.encodeEffect(cB)({ x: 1n, y: 2n });
      expect(encA).toStrictEqual(encB);
    }),
  );

  it.effect("tagged union + sparse-map combo (TxBody-shape with DCert field)", () =>
    Effect.gen(function* () {
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
      const encoded = yield* Schema.encodeEffect(c)(v);
      expect(encoded).toStrictEqual(
        map([
          { k: u(2n), v: u(10n) },
          {
            k: u(4n),
            v: arr([arr([u(0n), t("abc")]), arr([u(1n), t("def")])]),
          },
        ]),
      );
      const decoded = yield* Schema.decodeEffect(c)(encoded);
      expect(decoded).toStrictEqual(v);
    }),
  );
});

void bytes;
void tag;
