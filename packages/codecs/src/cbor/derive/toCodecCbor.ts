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
  collectUnionSentinels,
  isCborLinkFactory,
  taggedUnionLink,
} from "./compositeLinks";
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

/**
 * Read a `toCborLink` annotation if present, returning the factory. Returns
 * `undefined` when the annotation is absent or not a function (the walker
 * falls through to default derivation in that case).
 */
const readCborLinkAnnotation = (ast: AST.AST): ((ast: AST.AST) => AST.Link) | undefined => {
  const ann = ast.annotations?.toCborLink;
  return isCborLinkFactory(ann) ? ann : undefined;
};

/**
 * Prepare each member of a sentinel-based Union for `taggedUnionLink` by:
 *
 *   1. Stripping the member Objects' top-level encoding (otherwise Effect's
 *      Objects parser would fire `objectsLink` before `taggedUnionLink`,
 *      producing a CBOR Map that the Union-level Link can't dispatch).
 *   2. Stripping the tag propertySignature's `type.encoding` so Effect's
 *      field walk leaves `_tag` as the raw literal during both encode and
 *      decode. `taggedUnionLink` is responsible for moving the tag to/from
 *      the first slot of the CBOR Array; per-field literal encoding on the
 *      tag would round-trip it through CborValue unnecessarily.
 *
 * All other propertySignatures' encodings survive — they stay on
 * `ps.type.encoding` and are applied by Effect's Objects parser in the
 * normal way, producing a record of CborValue field values that
 * `taggedUnionLink` just arranges positionally.
 */
const stripTagMemberEncodings = (union: AST.Union, tagField: string): AST.Union =>
  new AST.Union(
    union.types.map((m) => {
      if (!AST.isObjects(m)) return AST.replaceEncoding(m, undefined);
      const newPropertySignatures = m.propertySignatures.map((ps) =>
        String(ps.name) === tagField
          ? new AST.PropertySignature(ps.name, AST.replaceEncoding(ps.type, undefined))
          : ps,
      );
      const stripped = new AST.Objects(
        newPropertySignatures,
        m.indexSignatures,
        m.annotations,
        m.checks,
        undefined,
        m.context,
      );
      return stripped;
    }),
    union.mode,
    union.annotations,
    union.checks,
    union.encoding,
    union.context,
  );

export const deriveCborWalker = AST.toCodec((ast) => {
  const out = deriveCborBase(ast);
  if (out !== ast && AST.isOptional(ast)) {
    return AST.optionalKeyLastLink(out);
  }
  return out;
});

/**
 * Apply custom `toCborLink` annotation on top of an AST that already has a
 * default encoding. Wrapping primitives (`cborTaggedLink`, `cborInCborLink`,
 * `strictMaybe`) rely on `lastLink(walked)` returning the default — so
 * the walker attaches default first, then calls custom, then replaces the
 * encoding array with the custom Link.
 */
function applyCustom(walked: AST.AST): AST.AST {
  const custom = readCborLinkAnnotation(walked);
  return custom ? AST.replaceEncoding(walked, [custom(walked)]) : walked;
}

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
      return applyCustom(ast);
    }

    case "String":
      return applyCustom(AST.replaceEncoding(ast, [stringLink]));
    case "Number":
      return applyCustom(AST.replaceEncoding(ast, [numberLink]));
    case "BigInt":
      return applyCustom(AST.replaceEncoding(ast, [bigintLink]));
    case "Boolean":
      return applyCustom(AST.replaceEncoding(ast, [booleanLink]));
    case "Null":
      return applyCustom(AST.replaceEncoding(ast, [nullLink]));
    case "Undefined":
    case "Void":
      return applyCustom(AST.replaceEncoding(ast, [undefinedLink]));
    case "Literal":
      return applyCustom(AST.replaceEncoding(ast, [literalLink(ast.literal)]));
    case "Enum":
      return applyCustom(AST.replaceEncoding(ast, [enumLink(ast.enums)]));

    case "Objects": {
      if (ast.propertySignatures.some((ps) => typeof ps.name !== "string")) {
        throw new Error("CBOR Struct property names must be strings", { cause: ast });
      }
      const recurred = ast.recur(deriveCborWalker);
      if (!AST.isObjects(recurred)) return recurred;
      const withDefault = AST.replaceEncoding(recurred, [objectsLink(recurred)]);
      return applyCustom(withDefault);
    }

    case "Arrays": {
      const recurred = ast.recur(deriveCborWalker);
      const withDefault = AST.replaceEncoding(recurred, [arraysLink]);
      return applyCustom(withDefault);
    }

    case "Union": {
      const recurred = ast.recur(deriveCborWalker);
      if (!AST.isUnion(recurred)) return recurred;
      // Explicit `toCborLink` wins over auto-detection. Custom links on
      // non-tagged unions don't need tag stripping — assume the author knows
      // what they want and pass the walked Union through as-is.
      const custom = readCborLinkAnnotation(recurred);
      if (custom) {
        return AST.replaceEncoding(recurred, [custom(recurred)]);
      }
      // Auto-detect Cardano-style tagged unions via the `_tag` sentinel that
      // `Schema.toTaggedUnion("_tag")` attaches. When every member exposes a
      // literal sentinel at that key, the union encodes as `[tag, ...fields]`
      // per the Cardano convention without further annotation.
      const sentinels = collectUnionSentinels(recurred, "_tag");
      if (sentinels.length > 0) {
        const stripped = stripTagMemberEncodings(recurred, "_tag");
        return AST.replaceEncoding(stripped, [taggedUnionLink("_tag")(stripped)]);
      }
      return recurred;
    }

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
