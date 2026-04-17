import {
  Effect,
  Option,
  Predicate,
  Schema,
  SchemaAST as AST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { CborKinds, type CborValue, CborValue as CborValueSchema } from "../CborValue";
import { CborBytes } from "../codec/CborBytes";
import "./annotations";
import {
  bigintLink,
  booleanLink,
  literalLink,
  nullLink,
  numberLink,
  stringLink,
  undefinedLink,
} from "./links";

// ────────────────────────────────────────────────────────────────────────────
// Walker — mirrors Effect's toCodecJson (see
// `~/code/reference/effect-smol/packages/effect/src/internal/schema/to-codec.ts`).
// Rewrites a schema's encoding chain so `Encoded = CborValue`. Composed with
// `CborBytes` to get `Encoded = Uint8Array`.
//
// Dispatch convention: kind-level pattern-matching uses the tagged-union
// utilities on CborValueSchema (`.match`/`.guards`/`.isAnyOf`) — never manual
// `_tag === CborKinds.X` comparisons. See `./links.ts` for the shared idiom.
// ────────────────────────────────────────────────────────────────────────────

const invalid = <T>(value: T, message: string): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message }));

/**
 * Build a case-set for `CborValueSchema.match` where every kind except those
 * overridden by the caller fails with a descriptive error. Callers spread
 * this into their match and override the accepted kinds.
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
// Composite Link — Objects (Struct) ↔ CborValue(Map) with Text keys.
// Uses `Array.prototype.toSorted` to emit keys in lex order for canonical form
// (RFC 8949 §4.2.1 — canonical map key ordering).
// ────────────────────────────────────────────────────────────────────────────

const objectsLink = (ast: AST.Objects): AST.Link => {
  const names = ast.propertySignatures.map((ps) => String(ps.name));
  const nameSet = new Set(names);

  return new AST.Link(
    CborValueSchema.ast,
    SchemaTransformation.transformOrFail<Record<string, CborValue>, CborValue>({
      decode: CborValueSchema.match({
        ...failOthers("Map for Struct"),
        [CborKinds.Map]: (cbor) =>
          Effect.gen(function* () {
            const out: Record<string, CborValue> = {};
            for (const entry of cbor.entries) {
              if (!CborValueSchema.guards[CborKinds.Text](entry.k)) {
                return yield* invalid(entry.k, "CBOR Map key must be Text for Struct decoding");
              }
              if (nameSet.has(entry.k.text)) out[entry.k.text] = entry.v;
            }
            return out;
          }),
      }),
      encode: (obj) => {
        const entries = names
          .toSorted()
          .filter((k) => k in obj)
          .map((k) => ({
            k: CborValueSchema.make({ _tag: CborKinds.Text, text: k }),
            v: obj[k]!,
          }));
        return Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Map, entries }));
      },
    }),
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Composite Link — Arrays/Tuples ↔ CborValue(Array)
// ────────────────────────────────────────────────────────────────────────────

const arraysLink: AST.Link = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<readonly CborValue[], CborValue>({
    decode: CborValueSchema.match({
      ...failOthers("Array"),
      [CborKinds.Array]: (v) => Effect.succeed(v.items),
    }),
    encode: (items) => Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Array, items })),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// Enum Link — numeric enums encode as UInt/NegInt, string enums as Text.
// Accept UInt or NegInt on decode via `.isAnyOf` for integer-valued enums;
// Text for string-valued enums via `.guards[CborKinds.Text]`.
// ────────────────────────────────────────────────────────────────────────────

const enumLink = (enums: ReadonlyArray<readonly [string, string | number]>): AST.Link => {
  const validValues = new Set(enums.map(([, v]) => v));
  const isIntegerCbor = CborValueSchema.isAnyOf([CborKinds.UInt, CborKinds.NegInt]);

  return new AST.Link(
    CborValueSchema.ast,
    SchemaTransformation.transformOrFail<string | number, CborValue>({
      decode: (cbor) => {
        if (isIntegerCbor(cbor)) {
          const n = Number(cbor.num);
          if (validValues.has(n)) return Effect.succeed(n);
          return invalid(cbor, `CBOR integer ${n} not a member of enum`);
        }
        if (CborValueSchema.guards[CborKinds.Text](cbor) && validValues.has(cbor.text)) {
          return Effect.succeed(cbor.text);
        }
        return invalid(cbor, "CBOR value not a member of enum");
      },
      encode: (value) => {
        if (typeof value === "number") {
          const big = BigInt(value);
          return Effect.succeed(
            big >= 0n
              ? CborValueSchema.make({ _tag: CborKinds.UInt, num: big })
              : CborValueSchema.make({ _tag: CborKinds.NegInt, num: big }),
          );
        }
        return Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Text, text: value }));
      },
    }),
  );
};

// ────────────────────────────────────────────────────────────────────────────
// Main walker — mirrors toCodecJsonBase arm-by-arm.
// ────────────────────────────────────────────────────────────────────────────

const deriveCborWalker = AST.toCodec((ast) => {
  const out = deriveCborBase(ast);
  if (out !== ast && AST.isOptional(ast)) {
    return AST.optionalKeyLastLink(out);
  }
  return out;
});

function deriveCborBase(ast: AST.AST): AST.AST {
  switch (ast._tag) {
    case "Declaration": {
      const annotations = ast.annotations;
      const getLink = annotations?.toCodecCbor ?? annotations?.toCodec;
      if (Predicate.isFunction(getLink)) {
        const tps = ast.typeParameters.map((tp) => Schema.make(AST.toEncoded(tp)));
        const link = getLink(tps);
        const to = deriveCborWalker(link.to);
        return AST.replaceEncoding(
          ast,
          to === link.to ? [link] : [new AST.Link(to, link.transformation)],
        );
      }
      return ast;
    }

    case "String":
      return AST.replaceEncoding(ast, [stringLink]);
    case "Number":
      return AST.replaceEncoding(ast, [numberLink]);
    case "BigInt":
      return AST.replaceEncoding(ast, [bigintLink]);
    case "Boolean":
      return AST.replaceEncoding(ast, [booleanLink]);
    case "Null":
      return AST.replaceEncoding(ast, [nullLink]);
    case "Undefined":
    case "Void":
      return AST.replaceEncoding(ast, [undefinedLink]);
    case "Literal":
      return AST.replaceEncoding(ast, [literalLink(ast.literal)]);
    case "Enum":
      return AST.replaceEncoding(ast, [enumLink(ast.enums)]);

    case "Objects": {
      if (ast.propertySignatures.some((ps) => typeof ps.name !== "string")) {
        throw new Error("CBOR Struct property names must be strings", { cause: ast });
      }
      const recurred = ast.recur(deriveCborWalker);
      if (recurred._tag === "Objects") {
        return AST.replaceEncoding(recurred, [objectsLink(recurred)]);
      }
      return recurred;
    }

    case "Arrays": {
      const recurred = ast.recur(deriveCborWalker);
      return AST.replaceEncoding(recurred, [arraysLink]);
    }

    case "Union":
    case "Suspend":
      return ast.recur(deriveCborWalker);
  }
  return ast;
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Derive a Codec<T, CborValue> from a schema. Walks the AST arm-by-arm,
 * attaching Links that transform each TS type to/from its CborValue
 * representation (primitives emit scalar variants; Struct emits Map; Array
 * emits Array).
 */
export const toCodecCbor = <T, E, RD, RE>(
  schema: Schema.Codec<T, E, RD, RE>,
): Schema.Codec<T, CborValue, RD, RE> => Schema.make(deriveCborWalker(schema.ast));

/**
 * Derive a Codec<T, Uint8Array> by composing `toCodecCbor` with the
 * `CborBytes` codec that serializes CborValue to RFC 8949 wire bytes.
 *
 * Composition direction: Uint8Array ← CborBytes → CborValue ← toCodecCbor →
 * T. Start at the encoded end (CborBytes: Codec<CborValue, Uint8Array>) and
 * decode up to the domain type via `decodeTo`.
 */
export const toCodecCborBytes = <T, E, RD, RE>(
  schema: Schema.Codec<T, E, RD, RE>,
): Schema.Codec<T, Uint8Array, RD, RE> => CborBytes.pipe(Schema.decodeTo(toCodecCbor(schema)));
