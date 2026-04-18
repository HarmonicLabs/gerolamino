import { Option, Predicate, Schema, SchemaAST as AST } from "effect";
import { memoize } from "effect/Function";
import type { MemPackCodec } from "../MemPackCodec";
import { MemPackDecodeError, MemPackEncodeError } from "../MemPackError";
import { bool, float64, list, tag, text, tuple, varLen } from "../primitives";
import { readMemPackAnnotation } from "./annotations";

// ────────────────────────────────────────────────────────────────────────────
// Architecture B — function-producing derivation (mirrors Effect's own
// `toArbitrary` / `toEquivalence`). MemPack bytes are not self-describing, so
// there's no intermediate IR to rewrite. Instead, each AST kind recursively
// builds a `MemPackCodec<T>` directly.
//
// Memoization: `memoize()` on the top-level `toCodecMemPack` handles non-
// recursive sharing. `AST.memoizeThunk` inside the Suspend branch breaks
// recursion cycles exactly like `toArbitrary` does.
//
// Dispatch per kind:
//   String / Boolean / BigInt / Number / Literal / Enum / Null / Undefined
//     → primitive codec (typeName unchanged).
//   Arrays    → list(elementCodec)            — Length + elements.
//   Objects   → positional tuple of fields    — no key serialization.
//   Union     → tagged-union: Word8 tag + member fields. MemPack requires a
//               literal discriminator on every member; untagged unions
//               unsupported (throw at derivation time, not runtime).
//   Suspend   → lazy thunk, memoized via AST.memoizeThunk.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Type-erasure bridge. `MemPackCodec<T>` is invariant in T — T appears in
 * both `packInto` input (contravariant) and `unpack` output (covariant)
 * positions, so widening a specific `MemPackCodec<string>` to
 * `MemPackCodec<unknown>` cannot be expressed structurally. Effect's own
 * walkers (`toArbitrary`, `toEquivalence`) take the same shortcut via
 * `any`; we restrict the erasure to a single named helper with a documented
 * safety argument and keep `unknown` everywhere else.
 *
 * Soundness: the walker memoizes codecs keyed by AST node and the public-
 * API `toCodecMemPack(schema)` round-trips the T parameter through
 * `schema.ast`. A value handed to an erased codec always originates from a
 * caller whose T matches the AST the codec was built for; the erasure is a
 * single WeakMap indirection, never a runtime boundary.
 */
const erase = <T>(codec: MemPackCodec<T>): MemPackCodec<unknown> =>
  codec as unknown as MemPackCodec<unknown>;

/** Mirror of `erase` in the narrowing direction. Same soundness argument. */
const reify = <T>(codec: MemPackCodec<unknown>): MemPackCodec<T> =>
  codec as unknown as MemPackCodec<T>;

const memPackMemoMap = new WeakMap<AST.AST, MemPackCodec<unknown>>();

const constantCodec = <T>(typeName: string, value: T): MemPackCodec<T> => ({
  typeName,
  packedByteCount: () => 0,
  packInto: (_v, _view, offset) => offset,
  unpack: (_view, offset) => ({ value, offset }),
});

// Struct = positional concatenation of required field codecs, ordered by
// property-signature declaration order. Optional fields use a 1-byte Maybe
// tag (0 = absent, 1 = present), matching Haskell's `Maybe` instance.

/**
 * A compiled per-field codec bundle. The three hot-path operations (sizing,
 * writing, reading) are materialized once at construction so the struct
 * loop never re-branches on `isOptional` or re-indexes parallel arrays.
 * `readInto` mutates a local `out` record to avoid O(n²) spread.
 */
type Slot = {
  readonly label: string;
  readonly sizeOf: (obj: Record<string, unknown>) => number;
  readonly writeInto: (obj: Record<string, unknown>, view: DataView, pos: number) => number;
  readonly readInto: (view: DataView, pos: number, out: Record<string, unknown>) => number;
};

const requiredSlot = (name: string, codec: MemPackCodec<unknown>): Slot => ({
  label: `${name}: ${codec.typeName}`,
  sizeOf: (obj) => codec.packedByteCount(obj[name]),
  writeInto: (obj, view, pos) => codec.packInto(obj[name], view, pos),
  readInto: (view, pos, out) => {
    const { value, offset } = codec.unpack(view, pos);
    out[name] = value;
    return offset;
  },
});

const optionalSlot = (name: string, codec: MemPackCodec<unknown>): Slot => ({
  label: `${name}: ${codec.typeName}`,
  sizeOf: (obj) => (obj[name] === undefined ? 1 : 1 + codec.packedByteCount(obj[name])),
  writeInto: (obj, view, pos) => {
    const v = obj[name];
    return v === undefined
      ? tag.packInto(0, view, pos)
      : codec.packInto(v, view, tag.packInto(1, view, pos));
  },
  readInto: (view, pos, out) => {
    const { value: flag, offset: afterTag } = tag.unpack(view, pos);
    switch (flag) {
      case 0:
        return afterTag;
      case 1: {
        const { value, offset } = codec.unpack(view, afterTag);
        out[name] = value;
        return offset;
      }
      default:
        throw new MemPackDecodeError({
          cause: `Optional field '${name}': invalid presence tag ${flag}`,
        });
    }
  },
});

const structCodec = (
  ast: AST.Objects,
  fields: ReadonlyArray<MemPackCodec<unknown>>,
): MemPackCodec<Record<string, unknown>> => {
  // Zip the three parallel (name, codec, isOptional) axes into a single Slot
  // array at construction; optional-vs-required branching happens once, not
  // on every call. Each hot-path operation reduces over `slots`, threading
  // cumulative size / write-offset / read-offset through the accumulator.
  const slots = ast.propertySignatures.map((ps, i) =>
    AST.isOptional(ps.type)
      ? optionalSlot(String(ps.name), fields[i]!)
      : requiredSlot(String(ps.name), fields[i]!),
  );
  const typeName = `{${slots.map((s) => s.label).join(", ")}}`;

  return {
    typeName,
    packedByteCount: (obj) => slots.reduce((size, s) => size + s.sizeOf(obj), 0),
    packInto: (obj, view, offset) =>
      slots.reduce((pos, s) => s.writeInto(obj, view, pos), offset),
    unpack: (view, offset) => {
      const out: Record<string, unknown> = {};
      const finalPos = slots.reduce((pos, s) => s.readInto(view, pos, out), offset);
      return { value: out, offset: finalPos };
    },
  };
};

// Tagged-union = 1-byte Tag discriminator + member struct fields. Requires
// every member to have a literal discriminator on a common key — this is the
// same "sentinel" condition Effect's own AST uses for O(1) union dispatch
// (`SchemaAST.ts:2090-2202`).

/** Word8 (0..255 integer) — MemPack's 1-byte discriminator range. */
const isWord8 = Schema.is(
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 255 })),
);

type UnionArm = {
  readonly label: string;
  readonly tagByte: number;
  readonly codec: MemPackCodec<Record<string, unknown>>;
};

const taggedUnionCodec = (
  discriminatorKey: PropertyKey,
  discriminatorLiterals: ReadonlyArray<AST.LiteralValue>,
  memberCodecs: ReadonlyArray<MemPackCodec<Record<string, unknown>>>,
): MemPackCodec<Record<string, unknown>> => {
  const keyStr = String(discriminatorKey);
  // Zip literals and member codecs into arms; `isWord8` enforces the
  // 0..255-integer constraint at construction time (string-keyed tagged
  // unions must provide an explicit annotation or use `Schema.Enum` for a
  // Word8 mapping).
  const arms = discriminatorLiterals.map((lit, i): UnionArm => {
    if (!isWord8(lit)) {
      throw new Error(
        `MemPack tagged union requires 0..255 integer tags on '${keyStr}', got ${String(lit)}`,
      );
    }
    return { label: String(lit), tagByte: lit, codec: memberCodecs[i]! };
  });
  // O(1) dispatch by tag byte replaces the prior `indexOf`-based scan.
  const byTag = new Map(arms.map((a) => [a.tagByte, a] as const));
  const typeName = `Union(${arms.map((a) => a.label).join(" | ")})`;

  const armFor = (
    tagValue: unknown,
    makeError: (cause: string) => Error,
  ): UnionArm =>
    Option.fromUndefinedOr(byTag.get(Number(tagValue))).pipe(
      Option.getOrThrowWith(() =>
        makeError(`${typeName}: unknown tag ${String(tagValue)}`),
      ),
    );
  const encodeArm = (v: Record<string, unknown>): UnionArm =>
    armFor(v[keyStr], (cause) => new MemPackEncodeError({ cause }));
  const decodeArm = (tagByte: number): UnionArm =>
    armFor(tagByte, (cause) => new MemPackDecodeError({ cause }));

  return {
    typeName,
    packedByteCount: (value) => 1 + encodeArm(value).codec.packedByteCount(value),
    packInto: (value, view, offset) => {
      const arm = encodeArm(value);
      return arm.codec.packInto(value, view, tag.packInto(arm.tagByte, view, offset));
    },
    unpack: (view, offset) => {
      const { value: tagByte, offset: afterTag } = tag.unpack(view, offset);
      return decodeArm(tagByte).codec.unpack(view, afterTag);
    },
  };
};

// Detect literal discriminator on every union member at a common key.
// Returns { key, literals[] } aligned with `ast.types` order, or undefined
// when the union is not a sentinel-based tagged union.
const detectTaggedUnion = (
  ast: AST.Union,
): { key: PropertyKey; literals: ReadonlyArray<AST.LiteralValue> } | undefined => {
  const memberSentinels = ast.types.map((t) => AST.collectSentinels(t));

  // For a given candidate key, probe every member for a non-symbol literal
  // sentinel. `Option.all` short-circuits to None on the first miss, so
  // (a) members with zero sentinels, (b) members lacking the key, and
  // (c) members whose literal is a symbol all disqualify the candidate
  // uniformly — the previous `some(s.length === 0)` pre-check folds into
  // this pipeline.
  const tryKey = (
    key: PropertyKey,
  ): Option.Option<{ key: PropertyKey; literals: ReadonlyArray<AST.LiteralValue> }> =>
    Option.all(
      memberSentinels.map((sentinels) =>
        Option.fromUndefinedOr(sentinels.find((s) => s.key === key)).pipe(
          // `flatMap` with a ternary lets the control-flow narrow `s.literal`
          // to `AST.LiteralValue` (symbol excluded); plain `Option.filter`
          // takes a `Predicate` and would not narrow the element type.
          Option.flatMap(
            (s): Option.Option<AST.LiteralValue> =>
              typeof s.literal === "symbol" ? Option.none() : Option.some(s.literal),
          ),
        ),
      ),
    ).pipe(Option.map((literals) => ({ key, literals })));

  // Candidate keys = keys on the first member's sentinel list (empty when
  // the first member has none, which correctly yields `undefined`).
  // `firstSomeOf` returns the first successful probe.
  return Option.firstSomeOf(
    (memberSentinels[0] ?? []).map((s) => tryKey(s.key)),
  ).pipe(Option.getOrUndefined);
};

// ────────────────────────────────────────────────────────────────────────────
// Arm-by-arm walker
// ────────────────────────────────────────────────────────────────────────────

const walk = (ast: AST.AST): MemPackCodec<unknown> => {
  const memo = memPackMemoMap.get(ast);
  if (memo) return memo;

  const annotation = readMemPackAnnotation(ast.annotations);
  if (Predicate.isFunction(annotation)) {
    const typeParameters: ReadonlyArray<MemPackCodec<unknown>> = AST.isDeclaration(ast)
      ? ast.typeParameters.map((tp) => walk(tp))
      : [];
    const out = annotation(typeParameters);
    memPackMemoMap.set(ast, out);
    return out;
  }

  const built = walkBase(ast);
  memPackMemoMap.set(ast, built);
  return built;
};

const walkBase = (ast: AST.AST): MemPackCodec<unknown> => {
  switch (ast._tag) {
    case "String":
      return erase(text);
    case "Boolean":
      return erase(bool);
    case "BigInt":
      return erase(varLen);
    case "Number":
      // Default Number -> float64; callers wanting integer encoding should
      // annotate their schema or use `Schema.BigInt` for varLen integers.
      return erase(float64);
    case "Null":
      return erase(constantCodec("Null", null));
    case "Undefined":
    case "Void":
      return erase(constantCodec("Undefined", undefined));
    case "Literal":
      return erase(constantCodec(`Literal(${String(ast.literal)})`, ast.literal));
    case "Enum":
      return erase(enumCodec(ast));
    case "Arrays":
      return erase(arraysCodec(ast));
    case "Objects":
      return erase(objectsCodec(ast));
    case "Union":
      return erase(unionCodec(ast));
    case "Suspend":
      // `suspendCodec` returns `MemPackCodec<unknown>` by construction
      // (delegates through `walk`), so no erasure needed here.
      return suspendCodec(ast);
    case "Declaration":
      // Without an annotation, Declaration nodes can't be derived — the
      // user must supply a MemPack codec via the `toCodecMemPack` annotation.
      throw new Error(
        `MemPack Declaration without toCodecMemPack annotation is not supported (id: ${String(ast.annotations?.id)})`,
      );
    default:
      throw new Error(`MemPack derivation: unsupported AST kind '${ast._tag}'`);
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Per-kind builders — each one preserves its specific `MemPackCodec<T>`
// return type so the dispatch in `walkBase` can apply `erase` once and
// downstream callers (e.g. `taggedUnionCodec`) can consume the narrow form
// without intermediate casts.
// ────────────────────────────────────────────────────────────────────────────

// Enum<A> where A is string | number — MemPack uses a 1-byte Tag for the
// position in the declared enum list. Requires 0..255 members.
const enumCodec = (ast: AST.Enum): MemPackCodec<string | number> => {
  const entries = ast.enums;
  if (entries.length > 256) {
    throw new Error(`MemPack Enum: ${entries.length} members exceeds 256`);
  }
  const values = entries.map(([, v]) => v);
  return {
    typeName: `Enum(${entries.map(([name]) => name).join(" | ")})`,
    packedByteCount: () => 1,
    packInto: (v, view, offset) => {
      const idx = values.indexOf(v);
      if (idx < 0) {
        throw new MemPackEncodeError({
          cause: `Enum: value ${String(v)} not a member`,
        });
      }
      return tag.packInto(idx, view, offset);
    },
    unpack: (view, offset) => {
      const { value: idx, offset: next } = tag.unpack(view, offset);
      // `values[idx]` is `string | number | undefined` under
      // `noUncheckedIndexedAccess`; `Option.fromUndefinedOr` folds the
      // bounds check into the Option pipeline.
      const value = Option.fromUndefinedOr(values[idx]).pipe(
        Option.getOrThrowWith(
          () => new MemPackDecodeError({ cause: `Enum: tag ${idx} out of range` }),
        ),
      );
      return { value, offset: next };
    },
  };
};

// Tuple vs Array distinction: fixed `elements` with no `rest` = tuple
// (fixed positional concat via the primitive `tuple` combinator);
// homogeneous rest-element list lowers to `list(inner)`.
const arraysCodec = (ast: AST.Arrays): MemPackCodec<ReadonlyArray<unknown>> => {
  if (ast.elements.length > 0 && ast.rest.length === 0) {
    return tuple(...ast.elements.map((e) => walk(e)));
  }
  if (ast.rest.length !== 1) {
    throw new Error(
      `MemPack Arrays: only fixed tuples and homogeneous lists supported; got ${ast.elements.length} elements + ${ast.rest.length} rest elements`,
    );
  }
  return list(walk(ast.rest[0]!));
};

const objectsCodec = (ast: AST.Objects): MemPackCodec<Record<string, unknown>> => {
  const fields = ast.propertySignatures.map((ps) => walk(ps.type));
  return structCodec(ast, fields);
};

const unionCodec = (ast: AST.Union): MemPackCodec<Record<string, unknown>> => {
  const detected = detectTaggedUnion(ast);
  if (!detected) {
    throw new Error(
      "MemPack Union: untagged unions unsupported. Use Schema.toTaggedUnion or provide a toCodecMemPack annotation.",
    );
  }
  // Every member MUST be an Objects AST (struct) for tagged-union wire
  // encoding. `Option.liftPredicate(AST.isObjects)` pairs the refinement
  // with the Option pipeline: `asObjects(t)` returns
  // `Option<AST.Objects>`, so the subsequent `objectsCodec` sees a
  // narrowed input at the type level — no `as` widening needed. The
  // `getOrThrowWith` branch records the failing member index for clear
  // diagnostics.
  const asObjects = Option.liftPredicate(AST.isObjects);
  const memberCodecs = ast.types.map((t, i) =>
    asObjects(t).pipe(
      Option.map(objectsCodec),
      Option.getOrThrowWith(
        () =>
          new Error(
            `MemPack Union: member ${i} must be a struct (Objects AST), got '${t._tag}'`,
          ),
      ),
    ),
  );
  return taggedUnionCodec(detected.key, detected.literals, memberCodecs);
};

// Break recursion cycles with a thunk-wrapping codec whose delegates are
// resolved lazily — mirrors `toArbitrary`'s Suspend branch. Returns
// `MemPackCodec<unknown>` directly because `walk(ast.thunk())` already
// yields the erased form.
const suspendCodec = (ast: AST.Suspend): MemPackCodec<unknown> => {
  const get = AST.memoizeThunk(() => walk(ast.thunk()));
  return {
    get typeName() {
      return get().typeName;
    },
    packedByteCount: (v) => get().packedByteCount(v),
    packInto: (v, view, offset) => get().packInto(v, view, offset),
    unpack: (view, offset) => get().unpack(view, offset),
  };
};

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Derive a `MemPackCodec<T>` from an Effect Schema by walking its AST.
 * Memoized per-AST-node; recursion cycles supported via `Schema.suspend` +
 * `AST.memoizeThunk`.
 *
 * The annotation `toCodecMemPack` (registered via module augmentation — see
 * `./annotations.ts`) overrides the default derivation for any schema.
 */
export const toCodecMemPack = memoize(
  <T, E, RD, RE>(schema: Schema.Codec<T, E, RD, RE>): MemPackCodec<T> =>
    reify<T>(walk(schema.ast)),
);
