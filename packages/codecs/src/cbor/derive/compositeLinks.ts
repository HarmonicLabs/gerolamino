import {
  Effect,
  Option,
  Predicate,
  Schema,
  SchemaAST as AST,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from "effect";
import { countBy } from "es-toolkit";
import { CborDerivationError } from "../CborError";
import { CborKinds, type CborValue, CborValue as CborValueSchema } from "../CborValue";

/** Build a `CborDerivationError` for a walker-time schema bug. */
const derivationError = (
  link: typeof CborDerivationError.fields.link.Type,
  astTag: string | undefined,
  message: string,
  cause?: unknown,
) => new CborDerivationError({ link, astTag, message, cause });
import { encode as encodeCborBytes, parse as parseCborBytes } from "../codec";
import "./annotations";

// ────────────────────────────────────────────────────────────────────────────
// Cardano-flavoured composite CBOR Links.
//
// Each factory returns a `CborLinkFactory` — a function that, given a fully
// walked AST, produces an `AST.Link` whose `to` is the `CborValue` AST. The
// walker (`deriveCborWalker`) applies these Links after recurring into
// children, so the factories can read each child's already-derived encoding
// via `child.encoding[last]`.
//
// Usage is twofold:
//  1. Attach as the `toCborLink` annotation on any Struct / Array / Union /
//     Declaration to override default CBOR encoding (e.g. sparse-map,
//     positional-array, Tag(258), Tag(24) encoded-CBOR).
//  2. Call directly to build a stand-alone `Link` at the user level, then
//     hand-wire it into a `Schema.decodeTo` composition.
//
// Dispatch rule (per project memory `feedback_use_match_isanyof.md`): never
// `cbor._tag === CborKinds.X` — use `CborValueSchema.match` /
// `CborValueSchema.guards` / `CborValueSchema.isAnyOf`.
// ────────────────────────────────────────────────────────────────────────────

/** A factory that builds a Link from a walked AST (children already walked). */
export type CborLinkFactory = (walkedAst: AST.AST) => AST.Link;

const invalid = <T>(value: T, message: string): Effect.Effect<never, SchemaIssue.InvalidValue> =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message }));

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

/**
 * Schema for an `AST.Link | undefined` result. Used to type `lastLink`'s
 * return via `Schema.Schema.Type<typeof MaybeLink>`, so the optionality is
 * expressed through the same type system that drives schema composition
 * rather than ad-hoc TS unions.
 */
const MaybeLink = Schema.UndefinedOr(Schema.instanceOf(AST.Link));

const lastLink = (ast: AST.AST): Schema.Schema.Type<typeof MaybeLink> => {
  const enc = ast.encoding;
  return enc && enc.length > 0 ? enc[enc.length - 1] : undefined;
};

/**
 * A Transformation whose decoded side is statically unknown (heterogeneous
 * child links) and whose encoded side is always a `CborValue` because every
 * Link in this module targets `CborValueSchema.ast`. The `R` channels are
 * erased to `unknown` at the AST level; the schema boundary
 * (`Schema.decodeSync` etc.) reseats them to `never`, so the `unknown`
 * channel never leaks to user code.
 */
type InnerTransformation = SchemaTransformation.Transformation<
  Schema.Schema.Type<typeof Schema.Unknown>,
  Schema.Schema.Type<typeof CborValueSchema>,
  unknown,
  unknown
>;

/**
 * Narrow a Link's transformation to a `Transformation` (not `Middleware`).
 * Every factory in this module uses `transformOrFail`, so in well-wired
 * composition this always succeeds; the guard is defensive. Returns an
 * Effect so misuse propagates through the Schema error channel as an
 * `Issue` instead of escaping as a JS exception — letting callers compose
 * with the rest of the decode/encode pipeline via `Effect.flatMap`.
 */
const asTransformation = (
  link: AST.Link,
): Effect.Effect<InnerTransformation, SchemaIssue.InvalidValue> =>
  SchemaTransformation.isTransformation(link.transformation)
    ? Effect.succeed(link.transformation)
    : invalid(link, "compositeLinks: expected Transformation, got Middleware");

const unwrapOrFail = <T>(
  opt: Option.Option<T>,
  fallbackValue: unknown,
  message: string,
): Effect.Effect<T, SchemaIssue.Issue> =>
  Option.match(opt, {
    onNone: () => invalid(fallbackValue, message),
    onSome: (v) => Effect.succeed(v),
  });

/**
 * Assert a value is a well-formed `CborValue`. Called on encode leaves where
 * a downstream Link (or pre-walked propertySignature) should have produced
 * one. Mis-wired composition surfaces as a descriptive Issue rather than
 * silently propagating garbage through the codec.
 */
const ensureCborValue = (
  value: unknown,
  context: string,
): Effect.Effect<CborValue, SchemaIssue.Issue> =>
  Schema.decodeUnknownEffect(CborValueSchema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new SchemaIssue.InvalidValue(Option.some(value), {
          message: `${context} — ${String(cause)}`,
        }),
    ),
  );

const runLinkDecode = (
  link: AST.Link,
  cbor: CborValue,
): Effect.Effect<unknown, SchemaIssue.Issue, unknown> =>
  asTransformation(link).pipe(
    Effect.flatMap((tr) => tr.decode.run(Option.some(cbor), {})),
    Effect.flatMap((opt) => unwrapOrFail(opt, cbor, "inner link decoded to None")),
  );

const runLinkEncode = (
  link: AST.Link,
  value: unknown,
): Effect.Effect<CborValue, SchemaIssue.Issue, unknown> =>
  asTransformation(link).pipe(
    Effect.flatMap((tr) => tr.encode.run(Option.some(value), {})),
    Effect.flatMap((opt) => unwrapOrFail(opt, value, "inner link encoded to None")),
    Effect.flatMap((v) => ensureCborValue(v, "inner link produced a non-CborValue")),
  );

// ────────────────────────────────────────────────────────────────────────────
// 1. taggedUnionLink — Cardano `[tag, ...fields]` encoding for sentinel-based
// discriminated unions. Each union member must be a `Schema.TaggedStruct`
// (or any Objects node carrying a literal sentinel at `tagField`). Encoding:
// `CBOR Array([UInt|Text(tag), field0, field1, ...])` where each `fieldN` is
// the CBOR encoding of the member's non-tag properties in declaration order.
//
// Sentinels: collected via `AST.collectSentinels`. Duplicate discriminants
// throw at construction. Supports number | bigint | string discriminants.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Schema for a tagged-union member's runtime dispatch metadata, built once
 * per Link from the walked Union AST (see {@link buildTaggedMembers}) and
 * consumed by encode/decode paths. Expressing this as a Schema — rather than
 * a hand-rolled TS type — gives every call site that touches a
 * {@link TaggedMember} value one shared source of truth for its shape:
 * `isTagKey` narrows to the discriminant-literal union, the `TagKey` /
 * `TaggedMember` types flow from the same declaration, and the walker's
 * invariants (non-empty `fields`, `tagKey` literal types) stay colocated.
 */
const TaggedMember = Schema.Struct({
  tagKey: Schema.Union([Schema.Number, Schema.BigInt, Schema.String]),
  fields: Schema.Struct({ name: Schema.String, isOptional: Schema.Boolean }).pipe(Schema.Array),
});
type TaggedMember = Schema.Schema.Type<typeof TaggedMember>;

/** The permitted discriminant-literal types, derived from {@link TaggedMember}. */
type TagKey = TaggedMember["tagKey"];
const isTagKey = Schema.is(TaggedMember.fields.tagKey);

/**
 * Build the dispatch table from a walked Union AST. Each of the three
 * per-member invariants (is an Objects, carries a sentinel at `tagField`,
 * has a literal of `TagKey` type) surfaces as an `Option.liftPredicate` /
 * `Option.fromUndefinedOr` gate finalized by `Option.getOrThrowWith`, so the
 * happy path stays a single `pipe` with the violation-messages colocated.
 * Duplicate detection falls out of `new Map(iterable)`'s silent-overwrite
 * semantics: a size mismatch vs. the source array identifies a collision.
 */
const buildTaggedMembers = (
  walkedUnion: AST.Union,
  tagField: string,
): ReadonlyMap<TagKey, TaggedMember> => {
  const members = walkedUnion.types.map((member): TaggedMember => {
    const objects = Option.liftPredicate(member, AST.isObjects).pipe(
      Option.getOrThrowWith(() =>
        derivationError(
          "taggedUnionLink",
          member._tag,
          "expected every union member to be an Objects (TaggedStruct)",
        ),
      ),
    );
    const sentinel = Option.fromUndefinedOr(
      AST.collectSentinels(objects).find((s) => s.key === tagField),
    ).pipe(
      Option.getOrThrowWith(() =>
        derivationError(
          "taggedUnionLink",
          objects._tag,
          `member has no literal sentinel at key "${tagField}"`,
        ),
      ),
    );
    const tagKey = Option.liftPredicate(sentinel.literal, isTagKey).pipe(
      Option.getOrThrowWith(() =>
        derivationError(
          "taggedUnionLink",
          objects._tag,
          `discriminant literal must be number | bigint | string; got ${typeof sentinel.literal}`,
        ),
      ),
    );
    const fields = objects.propertySignatures
      .filter((ps) => ps.name !== tagField)
      .map((ps) => ({ name: String(ps.name), isOptional: AST.isOptional(ps.type) }));
    return { tagKey, fields };
  });

  const byTag = new Map(members.map((m) => [m.tagKey, m] as const));
  if (byTag.size === members.length) return byTag;
  // Single O(n) pass over members finds the first tagKey used twice.
  // The former double-`findIndex` scan was O(n²) + lost the frequency
  // info; countBy surfaces the full multiplicity for diagnostics.
  const tagCounts = countBy(members, (m) => String(m.tagKey));
  const firstDup = Object.entries(tagCounts).find(([, count]) => count > 1);
  throw derivationError(
    "taggedUnionLink",
    undefined,
    `duplicate discriminant value ${firstDup?.[0] ?? "<unknown>"}`,
  );
};

/**
 * Encode a discriminant value (number | bigint | string) as the leading CBOR
 * Array slot: `UInt` for non-negative numeric, `NegInt` for negative numeric,
 * `Text` for string. Numbers promote to bigint for CBOR's integer encoding.
 */
const encodeDiscriminant = (tagKey: TagKey): CborValue => {
  if (typeof tagKey === "string") {
    return CborValueSchema.make({ _tag: CborKinds.Text, text: tagKey });
  }
  const n = typeof tagKey === "bigint" ? tagKey : BigInt(tagKey);
  return n >= 0n
    ? CborValueSchema.make({ _tag: CborKinds.UInt, num: n })
    : CborValueSchema.make({ _tag: CborKinds.NegInt, num: n });
};

/**
 * Pull the raw discriminant from the leading CBOR Array slot. `UInt`/`NegInt`
 * yield `bigint` (CBOR integers arrive as bigint); `Text` yields `string`.
 */
const decodeDiscriminant = (head: CborValue): Effect.Effect<bigint | string, SchemaIssue.Issue> =>
  CborValueSchema.isAnyOf([CborKinds.UInt, CborKinds.NegInt])(head)
    ? Effect.succeed(head.num)
    : CborValueSchema.guards[CborKinds.Text](head)
      ? Effect.succeed(head.text)
      : invalid(head, "tagged-union discriminant must be UInt/NegInt/Text");

/**
 * Look up a `TaggedMember` by either exact key match or numeric equivalence.
 * TS enums surface as numbers in `Schema.Enum`/`Literal`, but CBOR integers
 * decode to bigint — so we probe both representations before giving up.
 * `Option.orElse` chains the fallback lazily: the number↔bigint coercion
 * only runs if the direct hit missed.
 */
const lookupMemberByTag = (
  byTag: ReadonlyMap<TagKey, TaggedMember>,
  rawTag: TagKey,
): Option.Option<TaggedMember> =>
  Option.fromUndefinedOr(byTag.get(rawTag)).pipe(
    Option.orElse(() =>
      typeof rawTag === "bigint"
        ? Option.fromUndefinedOr(byTag.get(Number(rawTag)))
        : typeof rawTag === "number"
          ? Option.fromUndefinedOr(byTag.get(BigInt(rawTag)))
          : Option.none(),
    ),
  );

/**
 * Apply the Cardano `[tag, ...fields]` tagged-union encoding.
 *
 * The walker runs Effect's Objects parser on each member BEFORE this Link,
 * so on encode we receive a record where every non-tag field is already a
 * `CborValue` (encoded via the propertySignature's own encoding chain). The
 * tag field itself arrives as the raw literal because the walker strips the
 * tag propertySignature's encoding via `stripTagMemberEncodings` — that
 * lets us look up the member by exact sentinel match without a round-trip
 * through `literalLink`.
 *
 * On decode the direction is mirrored: we split the CBOR Array's head, use
 * it to select a member, and return a `{ [tagField]: rawTag, ...fields }`
 * record where fields are still `CborValue`s. Effect's Union dispatch then
 * matches the raw tag against member sentinels and runs the member's Objects
 * parser, which walks the remaining propertySignature encodings to produce
 * the final domain values.
 */
export const taggedUnionLink =
  (tagField: string): CborLinkFactory =>
  (walkedAst) => {
    const union = Option.liftPredicate(walkedAst, AST.isUnion).pipe(
      Option.getOrThrowWith(
        () => derivationError("taggedUnionLink", walkedAst._tag, "expected Union AST"),
      ),
    );
    const byTag = buildTaggedMembers(union, tagField);

    return new AST.Link(
      CborValueSchema.ast,
      SchemaTransformation.transformOrFail<Record<string, unknown>, CborValue>({
        decode: CborValueSchema.match({
          ...failOthers("Array for tagged union"),
          [CborKinds.Array]: (cbor) =>
            Effect.gen(function* () {
              // `noUncheckedIndexedAccess` types `cbor.items[0]` as
              // `CborValue | undefined`; lifting through `Option.fromUndefinedOr`
              // routes empty arrays and unknown-tag lookups through the shared
              // `unwrapOrFail` helper, keeping every miss a one-liner.
              const head = yield* unwrapOrFail(
                Option.fromUndefinedOr(cbor.items[0]),
                cbor,
                "tagged-union array must have at least the discriminant",
              );
              const rawTag = yield* decodeDiscriminant(head);
              const candidate = yield* unwrapOrFail(
                lookupMemberByTag(byTag, rawTag),
                head,
                `tagged-union discriminant ${String(rawTag)} matches no member`,
              );
              // Per-field Effects: present slots resolve to `[name, cbor]`,
              // absent optionals resolve to `undefined` (filtered out below via
              // the typed-tuple Schema.is predicate), absent requireds
              // short-circuit the whole `Effect.all` on the first miss.
              const fieldEntries = yield* Effect.all(
                candidate.fields.map((f, i) => {
                  const slot = cbor.items[i + 1];
                  if (slot !== undefined) return Effect.succeed([f.name, slot] as const);
                  return f.isOptional
                    ? Effect.succeed(undefined)
                    : invalid(
                        cbor,
                        `tagged-union member ${String(candidate.tagKey)} missing field "${f.name}"`,
                      );
                }),
              );
              return {
                [tagField]: candidate.tagKey,
                ...Object.fromEntries(
                  fieldEntries.filter(Schema.is(Schema.Tuple([Schema.String, CborValueSchema]))),
                ),
              };
            }),
        }),
        encode: (value) =>
          Effect.gen(function* () {
            // `Option.liftPredicate(…, isTagKey)` narrows rawTag to TagKey on
            // Some; `lookupMemberByTag` already returns `Option<TaggedMember>`.
            // Both gates collapse to `unwrapOrFail`, keeping the happy path
            // a single straight line of `yield*`s.
            const rawTag = yield* unwrapOrFail(
              Option.liftPredicate(value[tagField], isTagKey),
              value,
              `tagged-union discriminant must be number | bigint | string; got ${typeof value[tagField]}`,
            );
            const entry = yield* unwrapOrFail(
              lookupMemberByTag(byTag, rawTag),
              value,
              `tagged-union value has unknown discriminant ${String(rawTag)}`,
            );
            // Per-field Effects: `ensureCborValue` for present slots, an absent
            // optional resolves to `undefined` (filtered out below), an absent
            // required short-circuits the whole `Effect.all` on the first miss.
            const fieldItems = yield* Effect.all(
              entry.fields.map((f) => {
                const slot = value[f.name];
                if (slot !== undefined)
                  return ensureCborValue(slot, `tagged-union field "${f.name}" not a CborValue`);
                return f.isOptional
                  ? Effect.succeed(undefined)
                  : invalid(
                      value,
                      `tagged-union member ${String(entry.tagKey)} missing field "${f.name}"`,
                    );
              }),
            );
            return CborValueSchema.make({
              _tag: CborKinds.Array,
              items: [
                encodeDiscriminant(entry.tagKey),
                ...fieldItems.filter(Schema.is(CborValueSchema)),
              ],
            });
          }),
      }),
    );
  };

/**
 * Return a list of `{ key, literal }` sentinels for a Union AST by walking
 * each member (collect-sentinels only recurses into Objects / Declaration).
 * Returns an empty array if any member lacks a literal sentinel at the
 * supplied tag field — the caller uses this to decide whether to auto-apply
 * Cardano tagged-union encoding.
 */
export const collectUnionSentinels = (
  union: AST.Union,
  tagField: string,
): ReadonlyArray<AST.Sentinel> =>
  // Per-member `.find` becomes `Option<Sentinel>`; `Option.all` short-circuits
  // to `None` if any member lacks a sentinel at `tagField`, collapsing the
  // "return [] on first miss" early-exit into one pipeline.
  Option.all(
    union.types.map((m) =>
      Option.fromUndefinedOr(AST.collectSentinels(m).find((s) => s.key === tagField)),
    ),
  ).pipe(Option.getOrElse(() => []));

// ────────────────────────────────────────────────────────────────────────────
// 2. sparseMapLink — CBOR Map with integer UInt keys per the supplied
// mapping. Intended for Cardano TxBody / TxWitnessSet (per Conway CDDL §19).
// Optional fields absent on the source object are omitted (not emitted as
// UInt(key)→Null). Extra keys on the wire are silently discarded (forward
// compatibility for new TxBody slots added in later eras).
// ────────────────────────────────────────────────────────────────────────────

const validateKeyMapping = (keyMapping: Record<string, number>): void => {
  // `new Map(iterable)` silently overwrites duplicates, so a size mismatch
  // against the source entries flags at least one keyNum collision. The
  // winner for any collision sits at `byKeyNum.get(keyNum)`; any earlier
  // entry whose name is not the winner is a loser.
  const entries = Object.entries(keyMapping);
  const byKeyNum = new Map(entries.map(([name, keyNum]) => [keyNum, name] as const));
  if (byKeyNum.size === entries.length) return;
  Option.fromUndefinedOr(entries.find(([name, keyNum]) => byKeyNum.get(keyNum) !== name)).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: ([loserName, keyNum]) => {
        throw derivationError(
          "sparseMapLink",
          undefined,
          `integer key ${keyNum} mapped from both "${byKeyNum.get(keyNum)}" and "${loserName}"`,
        );
      },
    }),
  );
};

/**
 * Encode a `Schema.Struct` as a CBOR Map with integer keys.
 *
 * The walker attaches field-level encodings on each propertySignature before
 * this Link fires, so on encode we receive a record where every field value
 * is already a `CborValue` (for encoded fields) or `undefined` (for absent
 * optional fields). We simply arrange those pre-walked values into a
 * `Map(UInt(keyNum) → CborValue)` in integer-key-sorted order.
 *
 * Mirror on decode: emit `{ [field]: CborValue }` and let Effect's Objects
 * parser post-walk each propertySignature's encoding to produce the final
 * domain values.
 */
export const sparseMapLink =
  (keyMapping: Record<string, number>): CborLinkFactory =>
  (walkedAst) => {
    if (!AST.isObjects(walkedAst)) {
      throw derivationError("sparseMapLink", walkedAst._tag, "expected Objects AST");
    }
    validateKeyMapping(keyMapping);

    type Field = {
      readonly name: string;
      readonly keyNum: number;
      readonly isOptional: boolean;
    };

    const fields: readonly Field[] = walkedAst.propertySignatures.map((ps) => {
      const name = String(ps.name);
      const keyNum = Option.fromUndefinedOr(keyMapping[name]).pipe(
        Option.getOrThrowWith(() =>
          derivationError("sparseMapLink", walkedAst._tag, `field "${name}" has no integer-key mapping`),
        ),
      );
      return { name, keyNum, isOptional: AST.isOptional(ps.type) };
    });
    const fieldByKey = new Map(fields.map((f) => [f.keyNum, f] as const));

    return new AST.Link(
      CborValueSchema.ast,
      SchemaTransformation.transformOrFail<Record<string, unknown>, CborValue>({
        decode: CborValueSchema.match({
          ...failOthers("Map for sparse struct"),
          [CborKinds.Map]: (cbor) =>
            Effect.gen(function* () {
              // `Effect.all` short-circuits on the first invalid-key failure
              // (Effect.ts:741 default mode), preserving the prior per-entry
              // error pointing. Unknown integer keys map to `undefined` for
              // forward-compat and are dropped via the type-predicate filter.
              const isIntKey = CborValueSchema.isAnyOf([CborKinds.UInt, CborKinds.NegInt]);
              const pairs = yield* Effect.all(
                cbor.entries.map((entry) =>
                  isIntKey(entry.k)
                    ? Effect.succeed([fieldByKey.get(Number(entry.k.num))?.name, entry.v] as const)
                    : invalid(entry.k, "sparse-map key must be UInt/NegInt"),
                ),
              );
              const out = Object.fromEntries(
                pairs.filter(Schema.is(Schema.Tuple([Schema.String, CborValueSchema]))),
              );
              if (!fields.every((f) => f.name in out || f.isOptional)) {
                return yield* invalid(
                  cbor,
                  `sparse-map missing required field(s): ${fields
                    .filter((f) => !(f.name in out) && !f.isOptional)
                    .map((f) => `"${f.name}" (key ${f.keyNum})`)
                    .join(", ")}`,
                );
              }
              return out;
            }),
        }),
        encode: (obj) =>
          Effect.gen(function* () {
            const present = fields
              .filter((f) => !(obj[f.name] === undefined && f.isOptional))
              .toSorted((a, b) => a.keyNum - b.keyNum);
            const entries: { k: CborValue; v: CborValue }[] = [];
            for (const f of present) {
              const slot = obj[f.name];
              if (slot === undefined) {
                if (f.isOptional) continue;
                return yield* invalid(obj, `sparse-map missing required field "${f.name}"`);
              }
              const v = yield* ensureCborValue(
                slot,
                `sparse-map field "${f.name}" (key ${f.keyNum}) not a CborValue`,
              );
              entries.push({
                k: CborValueSchema.make({ _tag: CborKinds.UInt, num: BigInt(f.keyNum) }),
                v,
              });
            }
            return CborValueSchema.make({ _tag: CborKinds.Map, entries });
          }),
      }),
    );
  };

// ────────────────────────────────────────────────────────────────────────────
// 3. cborTaggedLink — wrap the inner encoding in CBOR Tag(tagNum).
// Use sites: Tag(258) nonempty-set markers, Tag(30) rationals.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Wrap the walked-AST's inner encoding in CBOR Tag(tagNum). Encode lifts the
 * inner link's output inside `{ _tag: Tag, tag: tagNum, data }`; decode
 * asserts the outer Tag variant + matching tag number before delegating.
 */
export const cborTaggedLink =
  (tagNum: bigint | number): CborLinkFactory =>
  (walkedAst) => {
    const expectedTag = typeof tagNum === "bigint" ? tagNum : BigInt(tagNum);
    const innerLink = lastLink(walkedAst);
    if (!innerLink) {
      throw derivationError("cborTaggedLink", undefined, "walked AST has no inner CBOR encoding");
    }
    return new AST.Link(
      CborValueSchema.ast,
      SchemaTransformation.transformOrFail<unknown, CborValue, unknown, unknown>({
        decode: CborValueSchema.match({
          ...failOthers(`Tag(${String(expectedTag)})`),
          [CborKinds.Tag]: (cbor) =>
            cbor.tag === expectedTag
              ? runLinkDecode(innerLink, cbor.data)
              : invalid(cbor, `Expected Tag ${String(expectedTag)}, got Tag ${cbor.tag}`),
        }),
        encode: (value) =>
          runLinkEncode(innerLink, value).pipe(
            Effect.map((data) =>
              CborValueSchema.make({ _tag: CborKinds.Tag, tag: expectedTag, data }),
            ),
          ),
      }),
    );
  };

// ────────────────────────────────────────────────────────────────────────────
// 4. cborInCborLink / cborInCborPreserving — RFC 8949 §3.4.5.1
// "encoded CBOR data item": Tag(24)(Bytes(inner_cbor_encoded)).
//
// The preserving variant threads the raw inner bytes through decode so
// `encode(decode(x))` emits `x` byte-for-byte. Required for hash-commitment
// types (AuxiliaryData → blake2b fed into TxBody[7]; TxBody → TxId;
// TxWitnessSet → block-level commitment).
// ────────────────────────────────────────────────────────────────────────────

export const ENCODED_CBOR_TAG = 24n;

const parseCborValueFromBytes = (bytes: Uint8Array): Effect.Effect<CborValue, SchemaIssue.Issue> =>
  parseCborBytes(bytes).pipe(
    Effect.mapError(
      (cause) =>
        new SchemaIssue.InvalidValue(Option.some(bytes), {
          message: `cborInCborLink: inner CBOR parse failed — ${String(cause)}`,
        }),
    ),
  );

const encodeCborValueToBytes = (cbor: CborValue): Effect.Effect<Uint8Array, SchemaIssue.Issue> =>
  encodeCborBytes(cbor).pipe(
    Effect.mapError(
      (cause) =>
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: `cborInCborLink: inner CBOR encode failed — ${String(cause)}`,
        }),
    ),
  );

/**
 * Plain cborInCborLink: Tag(24)(Bytes(serialized(inner))) on encode; on
 * decode extracts Bytes, parses them as CBOR, runs `innerLink`. Re-encode
 * produces canonical bytes — non-canonical inputs get canonicalized. Use
 * {@link cborInCborPreserving} when hash stability matters.
 */
export const cborInCborLink = (): CborLinkFactory => (walkedAst) => {
  const innerLink = lastLink(walkedAst);
  if (!innerLink) {
    throw derivationError("cborInCborLink", undefined, "walked AST has no inner CBOR encoding");
  }
  return new AST.Link(
    CborValueSchema.ast,
    SchemaTransformation.transformOrFail<unknown, CborValue, unknown, unknown>({
      decode: CborValueSchema.match({
        ...failOthers("Tag(24) for encoded-CBOR"),
        [CborKinds.Tag]: (cbor) =>
          cbor.tag === ENCODED_CBOR_TAG
            ? CborValueSchema.guards[CborKinds.Bytes](cbor.data)
              ? parseCborValueFromBytes(cbor.data.bytes).pipe(
                  Effect.flatMap((inner) => runLinkDecode(innerLink, inner)),
                )
              : invalid(cbor.data, "Tag(24) payload must be Bytes")
            : invalid(cbor, `Expected Tag(${String(ENCODED_CBOR_TAG)}), got Tag ${cbor.tag}`),
      }),
      encode: (value) =>
        runLinkEncode(innerLink, value).pipe(
          Effect.flatMap((inner) => encodeCborValueToBytes(inner)),
          Effect.map((bytes) =>
            CborValueSchema.make({
              _tag: CborKinds.Tag,
              tag: ENCODED_CBOR_TAG,
              data: CborValueSchema.make({ _tag: CborKinds.Bytes, bytes }),
            }),
          ),
        ),
    }),
  );
};

/**
 * Boxed form returned by {@link cborInCborPreserving}: carries the decoded
 * domain value alongside the raw inner CBOR bytes observed on the wire.
 * Hash-commitment callers (AuxiliaryData → `TxBody[7]`, TxBody → TxId,
 * TxWitnessSet → block-level commitment) re-emit `origBytes` verbatim so
 * `blake2b(re-encode(decode(x))) === blake2b(x)` holds even when the inner
 * CBOR was non-canonical on the wire. Values constructed by user code
 * without an `origBytes` field fall back to canonical re-encoding.
 */
export interface Preserved<T> {
  readonly value: T;
  readonly origBytes?: Uint8Array;
}

/**
 * Schema combinator wrapping an inner `Codec<T, CborValue>` in the RFC 8949
 * §3.4.5.1 "encoded CBOR" Tag(24)(Bytes) envelope **with byte preservation**.
 *
 * Declares a `Schema<Preserved<T>>` whose:
 *   - decode reads the inner Bytes payload, parses it, runs the inner codec
 *     on the parsed CborValue, and returns `{ value, origBytes }` with the
 *     raw bytes threaded through;
 *   - encode emits `origBytes` verbatim when present, else canonically
 *     re-encodes `value` through the inner codec.
 *
 * Implementation: builds a `Schema.declare` carrying a `toCborLink`
 * annotation. The walker's Declaration branch falls through to `applyCustom`
 * when no `toCodecCbor` is present and attaches the link — bypassing the
 * default declaration derivation that would otherwise recurse into
 * `CborValueSchema.ast` and attach spurious encoding to the target type.
 */
export const cborInCborPreserving = <T>(
  inner: Schema.Codec<T, CborValue, never, never>,
): Schema.declare<Preserved<T>> => {
  const isPreserved = (u: unknown): u is Preserved<T> =>
    typeof u === "object" && u !== null && "value" in u;

  const link = new AST.Link(
    CborValueSchema.ast,
    SchemaTransformation.transformOrFail<Preserved<T>, CborValue>({
      decode: CborValueSchema.match({
        ...failOthers("Tag(24) for encoded-CBOR"),
        [CborKinds.Tag]: (cbor) => {
          if (cbor.tag !== ENCODED_CBOR_TAG) {
            return invalid(cbor, `Expected Tag(${String(ENCODED_CBOR_TAG)}), got Tag ${cbor.tag}`);
          }
          if (!CborValueSchema.guards[CborKinds.Bytes](cbor.data)) {
            return invalid(cbor.data, "Tag(24) payload must be Bytes");
          }
          const preservedBytes = cbor.data.bytes;
          return parseCborValueFromBytes(preservedBytes).pipe(
            Effect.flatMap((innerCbor) => SchemaParser.decodeEffect(inner)(innerCbor)),
            Effect.map((value): Preserved<T> => ({ value, origBytes: preservedBytes })),
          );
        },
      }),
      encode: (preserved) => {
        if (preserved.origBytes !== undefined) {
          return Effect.succeed(
            CborValueSchema.make({
              _tag: CborKinds.Tag,
              tag: ENCODED_CBOR_TAG,
              data: CborValueSchema.make({ _tag: CborKinds.Bytes, bytes: preserved.origBytes }),
            }),
          );
        }
        return SchemaParser.encodeEffect(inner)(preserved.value).pipe(
          Effect.flatMap((innerCbor) => encodeCborValueToBytes(innerCbor)),
          Effect.map((bytes) =>
            CborValueSchema.make({
              _tag: CborKinds.Tag,
              tag: ENCODED_CBOR_TAG,
              data: CborValueSchema.make({ _tag: CborKinds.Bytes, bytes }),
            }),
          ),
        );
      },
    }),
  );

  return Schema.declare<Preserved<T>>(isPreserved).annotate({ toCborLink: () => link });
};

// ────────────────────────────────────────────────────────────────────────────
// 5. strictMaybe — Haskell `StrictMaybe a` as `[]` (Nothing) or `[x]` (Just).
// Distinct from `Schema.optional` (absent key) and CBOR Null.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Schema combinator wrapping an inner `Codec<T, CborValue>` in the Haskell
 * `StrictMaybe` wire shape: `Array(0)` for Nothing, `Array(1, [x])` for Just.
 *
 * Declares a `Schema<T | undefined>` that decodes `[]` to `undefined` and
 * `[x]` to `inner.decode(x)`. Encode maps `undefined` to `[]` and any other
 * value to `[inner.encode(value)]`.
 *
 * Implementation matches {@link cborInCborPreserving}: `Schema.declare` with
 * a `toCborLink` annotation. Because the declaration has no `toCodecCbor`
 * annotation, the walker's Declaration branch falls through to
 * `applyCustom` and attaches the link directly — avoiding the default
 * recursion into `CborValueSchema.ast`.
 */
export const strictMaybe = <T>(
  inner: Schema.Codec<T, CborValue, never, never>,
): Schema.declare<T | undefined> => {
  const isMaybeT = (_: unknown): _ is T | undefined => true;

  const link = new AST.Link(
    CborValueSchema.ast,
    SchemaTransformation.transformOrFail<T | undefined, CborValue>({
      decode: CborValueSchema.match({
        ...failOthers("Array(0|1) for StrictMaybe"),
        [CborKinds.Array]: (cbor) => {
          switch (cbor.items.length) {
            case 0:
              return Effect.succeed(undefined);
            case 1:
              return SchemaParser.decodeEffect(inner)(cbor.items[0]!);
            default:
              return invalid(
                cbor,
                `StrictMaybe array must have length 0 or 1, got ${cbor.items.length}`,
              );
          }
        },
      }),
      encode: (value) =>
        value === undefined
          ? Effect.succeed(CborValueSchema.make({ _tag: CborKinds.Array, items: [] }))
          : SchemaParser.encodeEffect(inner)(value).pipe(
              Effect.map((innerCbor) =>
                CborValueSchema.make({ _tag: CborKinds.Array, items: [innerCbor] }),
              ),
            ),
    }),
  );

  return Schema.declare<T | undefined>(isMaybeT).annotate({ toCborLink: () => link });
};

// ────────────────────────────────────────────────────────────────────────────
// 6. positionalArrayLink — encode a `Schema.Struct` as a fixed-length CBOR
// Array where each field occupies a positional slot (no key bytes). Matches
// Cardano ledger state layout (NewEpochState=7, EpochState=4, etc.).
// Trailing slots may be `Schema.optional`; leading/interior optionals are
// rejected at construction.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Encode a `Schema.Struct` as a fixed-length positional CBOR Array. Like
 * {@link sparseMapLink}, this Link sits above the propertySignature-level
 * encoding chain: on encode each slot value arrives as a pre-walked
 * `CborValue` (or `undefined` for absent trailing-optional slots) and we
 * simply concatenate them in declared order.
 *
 * On decode we split the array by position and hand each slot's CBOR back
 * to Effect's Objects parser under the declared field name; the parser then
 * runs the propertySignature's encoding chain to produce the final domain
 * value.
 */
export const positionalArrayLink =
  (fieldOrder: ReadonlyArray<string>): CborLinkFactory =>
  (walkedAst) => {
    if (!AST.isObjects(walkedAst)) {
      throw derivationError("positionalArrayLink", walkedAst._tag, "expected Objects AST");
    }

    type Slot = {
      readonly name: string;
      readonly isOptional: boolean;
    };

    const byName = new Map<string, AST.PropertySignature>();
    for (const ps of walkedAst.propertySignatures) byName.set(String(ps.name), ps);

    const slots: Slot[] = [];
    for (const name of fieldOrder) {
      const ps = byName.get(name);
      if (!ps) {
        throw derivationError(
          "positionalArrayLink",
          walkedAst._tag,
          `field "${name}" not present on struct`,
        );
      }
      slots.push({ name, isOptional: AST.isOptional(ps.type) });
    }

    const firstOptional = slots.findIndex((s) => s.isOptional);
    if (firstOptional !== -1) {
      for (let i = firstOptional + 1; i < slots.length; i++) {
        if (!slots[i]!.isOptional) {
          throw derivationError(
            "positionalArrayLink",
            walkedAst._tag,
            `optional slot at index ${firstOptional} ("${slots[firstOptional]!.name}") precedes required slot at ${i} ("${slots[i]!.name}") — only trailing optionals are allowed`,
          );
        }
      }
    }
    const requiredCount = firstOptional === -1 ? slots.length : firstOptional;

    // The positional Link sits above propertySignature-level encodings: each
    // field's domain value has already been transformed to a CborValue by the
    // time encode() runs, and decode()'s output rows feed back into the
    // Objects parser which runs the propertySignature encodings in reverse.
    // Typing the transformation's decoded side as `Record<string, CborValue>`
    // (via Schema.Record) threads that invariant through the compiler, so we
    // never re-validate each slot at runtime — the previous `ensureCborValue`
    // call on every slot collapses into a type-level guarantee.
    const PositionalRecord = Schema.Record(Schema.String, CborValueSchema);
    type PositionalRecord = Schema.Schema.Type<typeof PositionalRecord>;

    return new AST.Link(
      CborValueSchema.ast,
      SchemaTransformation.transformOrFail<PositionalRecord, CborValue>({
        decode: CborValueSchema.match({
          ...failOthers("Array for positional struct"),
          [CborKinds.Array]: (cbor) =>
            Effect.gen(function* () {
              if (cbor.items.length < requiredCount) {
                return yield* invalid(
                  cbor,
                  `positional array expected at least ${requiredCount} slots, got ${cbor.items.length}`,
                );
              }
              if (cbor.items.length > slots.length) {
                return yield* invalid(
                  cbor,
                  `positional array expected at most ${slots.length} slots, got ${cbor.items.length}`,
                );
              }
              return Object.fromEntries(cbor.items.map((item, i) => [slots[i]!.name, item]));
            }),
        }),
        encode: (obj) =>
          Effect.gen(function* () {
            // Build one Effect per slot. `Effect.all` short-circuits on the
            // first failure (Effect.ts:741 default mode), so missing-required
            // errors surface without per-slot accumulation. Optional-absent
            // slots resolve to `undefined`; the gap check after Effect.all
            // inspects the resolved tuple for trailing-only undefineds.
            const maybeItems = yield* Effect.all(
              slots.map((slot, i): Effect.Effect<CborValue | undefined, SchemaIssue.Issue> => {
                const v = obj[slot.name];
                if (v !== undefined) return Effect.succeed(v);
                return slot.isOptional
                  ? Effect.succeed(undefined)
                  : invalid(
                      obj,
                      `positional array missing required field "${slot.name}" at slot ${i}`,
                    );
              }),
            );

            const firstAbsent = maybeItems.indexOf(undefined);
            if (firstAbsent !== -1) {
              const gap = maybeItems.findIndex((it, i) => i > firstAbsent && it !== undefined);
              if (gap !== -1) {
                return yield* invalid(
                  obj,
                  `positional array has gap before slot ${gap} ("${slots[gap]!.name}")`,
                );
              }
            }

            const items = maybeItems.filter(Schema.is(CborValueSchema));
            return CborValueSchema.make({ _tag: CborKinds.Array, items });
          }),
      }),
    );
  };

// ────────────────────────────────────────────────────────────────────────────
// Schema-level wrappers — convenience factories returning Codecs directly.
// Use these at schema-definition sites when you don't want to fuss with
// annotations.
// ────────────────────────────────────────────────────────────────────────────

/** Is the supplied value a `CborLinkFactory`? Used by the walker. */
export const isCborLinkFactory = (u: unknown): u is CborLinkFactory => Predicate.isFunction(u);

/**
 * Attach a `toCborLink` annotation to a schema. Equivalent to
 * `schema.annotate({ toCborLink: factory })` but marshals the factory type
 * through Effect's annotation system.
 */
export const withCborLink =
  <S extends Schema.Top>(factory: CborLinkFactory) =>
  (schema: S): S["Rebuild"] =>
    schema.annotate({ toCborLink: factory });
