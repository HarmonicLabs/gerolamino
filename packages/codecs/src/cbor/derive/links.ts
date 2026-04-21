import {
  BigDecimal,
  Effect,
  Option,
  SchemaAST as AST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { CborKinds, type CborValue, CborValue as CborValueSchema } from "../CborValue";

// ────────────────────────────────────────────────────────────────────────────
// Primitive Links — one per scalar AST kind. Each Link's `to` is the
// CborValue AST; the transformation converts between the raw TS value and
// the corresponding CborValue variant.
//
// Pattern rule (per project memory `feedback_use_match_isanyof.md`):
// never `cbor._tag === CborKinds.X` — always dispatch via the tagged-union
// utilities from `Schema.toTaggedUnion("_tag")` on CborValueSchema:
//  • `.guards[CborKinds.X](cbor)`   — single-tag type predicate
//  • `.isAnyOf([CborKinds.X, ...])` — multi-tag type predicate
//  • `.match({ [CborKinds.X]: ... })` — exhaustive pattern match
// ────────────────────────────────────────────────────────────────────────────

const invalid = <T>(value: T, message: string): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message }));

/**
 * Build the "every non-matching kind fails" case-set passed to
 * `CborValueSchema.match`. Each entry produces a descriptive error naming
 * the actually-received kind via `CborKinds[cbor._tag]`. Callers spread this
 * into their match and override the kinds they accept.
 */
const failOthers = (expected: string) =>
  ({
    [CborKinds.UInt]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got UInt`),
    [CborKinds.NegInt]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got NegInt`),
    [CborKinds.Bytes]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Bytes`),
    [CborKinds.Text]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Text`),
    [CborKinds.Array]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Array`),
    [CborKinds.Map]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Map`),
    [CborKinds.Tag]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Tag`),
    [CborKinds.Simple]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Simple`),
  }) as const;

// ────────────────────────────────────────────────────────────────────────────
// Uint8Array <-> CborValue(Bytes)
// ────────────────────────────────────────────────────────────────────────────

export const bytesLink: AST.Link = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<Uint8Array, CborValue>({
    decode: CborValueSchema.match({
      ...failOthers("Bytes for Uint8Array"),
      [CborKinds.Bytes]: (v) => Effect.succeed(v.bytes),
    }),
    encode: (bytes) => Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Bytes, bytes })),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// String <-> CborValue(Text)
// ────────────────────────────────────────────────────────────────────────────

export const stringLink: AST.Link = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<string, CborValue>({
    decode: CborValueSchema.match({
      ...failOthers("Text for string"),
      [CborKinds.Text]: (v) => Effect.succeed(v.text),
    }),
    encode: (text) => Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Text, text })),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// Number <-> CborValue(UInt | NegInt | Simple(BigDecimal for floats))
// Integer-in-safe-range emits UInt/NegInt; non-integer emits Simple/float.
// ────────────────────────────────────────────────────────────────────────────

export const numberLink: AST.Link = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<number, CborValue>({
    decode: CborValueSchema.match({
      ...failOthers("UInt/NegInt/Float for number"),
      [CborKinds.UInt]: (v) =>
        v.num > BigInt(Number.MAX_SAFE_INTEGER)
          ? invalid(v, `CBOR UInt ${v.num} exceeds Number.MAX_SAFE_INTEGER`)
          : Effect.succeed(Number(v.num)),
      [CborKinds.NegInt]: (v) =>
        v.num < BigInt(Number.MIN_SAFE_INTEGER)
          ? invalid(v, `CBOR NegInt ${v.num} below Number.MIN_SAFE_INTEGER`)
          : Effect.succeed(Number(v.num)),
      [CborKinds.Simple]: (v) =>
        BigDecimal.isBigDecimal(v.value)
          ? Effect.succeed(BigDecimal.toNumberUnsafe(v.value))
          : invalid(v, "Expected CBOR Simple(Float), got non-float Simple"),
    }),
    encode: (n) => {
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return Effect.succeed(
          CborValueSchema.make({
            _tag: CborKinds.Simple,
            value: BigDecimal.fromNumberUnsafe(n),
          }),
        );
      }
      const big = BigInt(n);
      return Effect.succeed(
        big >= 0n
          ? CborValueSchema.make({ _tag: CborKinds.UInt, num: big })
          : CborValueSchema.make({ _tag: CborKinds.NegInt, num: big }),
      );
    },
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// BigInt <-> CborValue(UInt | NegInt | Tag(2/3, bytes))
// Values within unsigned/signed 64-bit range encode as UInt/NegInt; arbitrary
// precision values use RFC 8949 §3.4.3 bignum tags (2 = positive, 3 = -1-n).
// ────────────────────────────────────────────────────────────────────────────

const U64_MAX = (1n << 64n) - 1n;

const bigintToBytes = (n: bigint): Uint8Array => {
  if (n === 0n) return new Uint8Array(0);
  const hex = n.toString(16);
  const padded = hex.length % 2 === 0 ? hex : "0" + hex;
  return Uint8Array.fromHex(padded);
};

const bytesToBigint = (bytes: Uint8Array): bigint => {
  if (bytes.byteLength === 0) return 0n;
  return BigInt("0x" + bytes.toHex());
};

/**
 * Nested Tag(2|3, Bytes) → bigint. Applied only within bigintLink's Tag arm,
 * where `v.data` is a child CborValue and we dispatch on its kind via
 * `.guards[CborKinds.Bytes]`.
 */
const bignumPayload = (data: CborValue): Option.Option<Uint8Array> =>
  CborValueSchema.guards[CborKinds.Bytes](data) ? Option.some(data.bytes) : Option.none();

export const bigintLink: AST.Link = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<bigint, CborValue>({
    decode: CborValueSchema.match({
      ...failOthers("Integer or Bignum for bigint"),
      [CborKinds.UInt]: (v) => Effect.succeed(v.num),
      [CborKinds.NegInt]: (v) => Effect.succeed(v.num),
      [CborKinds.Tag]: (v) => {
        switch (v.tag) {
          case 2n:
            return bignumPayload(v.data).pipe(
              Option.match({
                onNone: () => invalid(v, "Tag 2 (positive bignum) payload must be Bytes"),
                onSome: (bytes) => Effect.succeed(bytesToBigint(bytes)),
              }),
            );
          case 3n:
            return bignumPayload(v.data).pipe(
              Option.match({
                onNone: () => invalid(v, "Tag 3 (negative bignum) payload must be Bytes"),
                onSome: (bytes) => Effect.succeed(-1n - bytesToBigint(bytes)),
              }),
            );
          default:
            return invalid(v, `Expected Tag 2 or 3 (bignum) for bigint, got Tag ${v.tag}`);
        }
      },
    }),
    encode: (n) => {
      // `switch (true)` dispatches on whichever predicate matches first; the
      // four arms partition ℤ into UInt64 / NegInt64 / positive-bignum /
      // negative-bignum without overlap, so ordering is exhaustive.
      switch (true) {
        case n >= 0n && n <= U64_MAX:
          return Effect.succeed(CborValueSchema.make({ _tag: CborKinds.UInt, num: n }));
        case n < 0n && -1n - n <= U64_MAX:
          return Effect.succeed(CborValueSchema.make({ _tag: CborKinds.NegInt, num: n }));
        case n > U64_MAX:
          return Effect.succeed(
            CborValueSchema.make({
              _tag: CborKinds.Tag,
              tag: 2n,
              data: CborValueSchema.make({ _tag: CborKinds.Bytes, bytes: bigintToBytes(n) }),
            }),
          );
        default:
          return Effect.succeed(
            CborValueSchema.make({
              _tag: CborKinds.Tag,
              tag: 3n,
              data: CborValueSchema.make({ _tag: CborKinds.Bytes, bytes: bigintToBytes(-1n - n) }),
            }),
          );
      }
    },
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// Boolean <-> CborValue(Simple(boolean))
// ────────────────────────────────────────────────────────────────────────────

export const booleanLink: AST.Link = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<boolean, CborValue>({
    decode: CborValueSchema.match({
      ...failOthers("Simple(boolean) for boolean"),
      [CborKinds.Simple]: (v) =>
        typeof v.value === "boolean"
          ? Effect.succeed(v.value)
          : invalid(v, "Expected CBOR Simple(boolean), got non-boolean Simple"),
    }),
    encode: (b) => Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Simple, value: b })),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// null <-> CborValue(Simple(null))   and   undefined <-> CborValue(Simple(undefined))
// ────────────────────────────────────────────────────────────────────────────

export const nullLink: AST.Link = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<null, CborValue>({
    decode: CborValueSchema.match({
      ...failOthers("Simple(null) for null"),
      [CborKinds.Simple]: (v) =>
        v.value === null
          ? Effect.succeed(null)
          : invalid(v, "Expected CBOR Simple(null), got different Simple value"),
    }),
    encode: () => Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Simple, value: null })),
  }),
);

export const undefinedLink: AST.Link = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<undefined, CborValue>({
    decode: CborValueSchema.match({
      ...failOthers("Simple(undefined) for undefined"),
      [CborKinds.Simple]: (v) =>
        v.value === undefined
          ? Effect.succeed(undefined)
          : invalid(v, "Expected CBOR Simple(undefined), got different Simple value"),
    }),
    encode: () =>
      Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Simple, value: undefined })),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// Literal — encode as the CBOR equivalent of the JS literal; decode validates
// equality. Literal types: string | number | bigint | boolean (AST.LiteralValue).
// ────────────────────────────────────────────────────────────────────────────

const bigintToCbor = (n: bigint): CborValue =>
  n >= 0n
    ? CborValueSchema.make({ _tag: CborKinds.UInt, num: n })
    : CborValueSchema.make({ _tag: CborKinds.NegInt, num: n });

const literalToCbor = (literal: AST.LiteralValue): CborValue => {
  switch (typeof literal) {
    case "string":
      return CborValueSchema.make({ _tag: CborKinds.Text, text: literal });
    case "boolean":
      return CborValueSchema.make({ _tag: CborKinds.Simple, value: literal });
    case "bigint":
      return bigintToCbor(literal);
    case "number":
      return Number.isInteger(literal)
        ? bigintToCbor(BigInt(literal))
        : CborValueSchema.make({
            _tag: CborKinds.Simple,
            value: BigDecimal.fromNumberUnsafe(literal),
          });
    default:
      throw new Error(`Unsupported literal type: ${typeof literal}`);
  }
};

/**
 * CBOR equality for an AST.LiteralValue. Dispatches on `typeof literal` then
 * uses `CborValueSchema.guards[...]` for kind narrowing — no `_tag` compares.
 */
const cborEqualsLiteral = (cbor: CborValue, literal: AST.LiteralValue): boolean => {
  // `isAnyOf([UInt, NegInt])` narrows `cbor` to the two integer variants,
  // both of which expose `num: bigint` — so the bigint / integer-number arms
  // collapse to a single comparison per case.
  switch (typeof literal) {
    case "string":
      return CborValueSchema.guards[CborKinds.Text](cbor) && cbor.text === literal;
    case "boolean":
      return CborValueSchema.guards[CborKinds.Simple](cbor) && cbor.value === literal;
    case "bigint":
      return (
        CborValueSchema.isAnyOf([CborKinds.UInt, CborKinds.NegInt])(cbor) && cbor.num === literal
      );
    case "number":
      return Number.isInteger(literal)
        ? CborValueSchema.isAnyOf([CborKinds.UInt, CborKinds.NegInt])(cbor) &&
            cbor.num === BigInt(literal)
        : CborValueSchema.guards[CborKinds.Simple](cbor) &&
            BigDecimal.isBigDecimal(cbor.value) &&
            BigDecimal.toNumberUnsafe(cbor.value) === literal;
    default:
      return false;
  }
};

export const literalLink = (literal: AST.LiteralValue): AST.Link =>
  new AST.Link(
    CborValueSchema.ast,
    SchemaTransformation.transformOrFail<AST.LiteralValue, CborValue>({
      decode: (cbor) =>
        cborEqualsLiteral(cbor, literal)
          ? Effect.succeed(literal)
          : invalid(cbor, `Expected CBOR literal ${String(literal)}`),
      encode: () => Effect.succeed(literalToCbor(literal)),
    }),
  );
