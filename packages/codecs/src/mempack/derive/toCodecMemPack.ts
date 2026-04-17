import { Predicate, Schema, SchemaAST as AST } from "effect";
import { memoize } from "effect/Function";
import type { MemPackCodec } from "../MemPackCodec";
import { MemPackDecodeError, MemPackEncodeError } from "../MemPackError";
import {
  bool,
  float64,
  length,
  list,
  tag,
  text,
  varLen,
} from "../primitives";
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
const structCodec = (ast: AST.Objects, fields: ReadonlyArray<MemPackCodec<unknown>>): MemPackCodec<Record<string, unknown>> => {
  const names = ast.propertySignatures.map((ps) => String(ps.name));
  const optionals = ast.propertySignatures.map((ps) => AST.isOptional(ps.type));
  const typeName = `{${names.map((n, i) => `${n}: ${fields[i]!.typeName}`).join(", ")}}`;

  return {
    typeName,
    packedByteCount: (obj) => {
      let size = 0;
      for (let i = 0; i < fields.length; i++) {
        const v = obj[names[i]!];
        if (optionals[i]) {
          size += 1; // presence tag
          if (v !== undefined) size += fields[i]!.packedByteCount(v);
        } else {
          size += fields[i]!.packedByteCount(v);
        }
      }
      return size;
    },
    packInto: (obj, view, offset) => {
      let pos = offset;
      for (let i = 0; i < fields.length; i++) {
        const v = obj[names[i]!];
        if (optionals[i]) {
          if (v === undefined) {
            pos = tag.packInto(0, view, pos);
          } else {
            pos = tag.packInto(1, view, pos);
            pos = fields[i]!.packInto(v, view, pos);
          }
        } else {
          pos = fields[i]!.packInto(v, view, pos);
        }
      }
      return pos;
    },
    unpack: (view, offset) => {
      const out: Record<string, unknown> = {};
      let pos = offset;
      for (let i = 0; i < fields.length; i++) {
        if (optionals[i]) {
          const { value: flag, offset: afterTag } = tag.unpack(view, pos);
          pos = afterTag;
          if (flag === 1) {
            const { value, offset: next } = fields[i]!.unpack(view, pos);
            out[names[i]!] = value;
            pos = next;
          } else if (flag !== 0) {
            throw new MemPackDecodeError({
              cause: `Optional field '${names[i]}': invalid presence tag ${flag}`,
            });
          }
        } else {
          const { value, offset: next } = fields[i]!.unpack(view, pos);
          out[names[i]!] = value;
          pos = next;
        }
      }
      return { value: out, offset: pos };
    },
  };
};

// Tagged-union = 1-byte Tag discriminator + member struct fields. Requires
// every member to have a literal discriminator on a common key — this is the
// same "sentinel" condition Effect's own AST uses for O(1) union dispatch
// (`SchemaAST.ts:2090-2202`).
const taggedUnionCodec = (
  discriminatorKey: PropertyKey,
  discriminatorLiterals: ReadonlyArray<AST.LiteralValue>,
  memberCodecs: ReadonlyArray<MemPackCodec<Record<string, unknown>>>,
): MemPackCodec<Record<string, unknown>> => {
  // The `discriminatorLiterals` must be numeric for MemPack's 1-byte tag;
  // string-keyed tagged unions must provide an explicit annotation (or use
  // `Schema.Enum` for a Word8 mapping).
  const tagNumbers = discriminatorLiterals.map((lit) => {
    if (typeof lit === "number" && Number.isInteger(lit) && lit >= 0 && lit <= 255) {
      return lit;
    }
    throw new Error(
      `MemPack tagged union requires 0..255 integer tags on '${String(discriminatorKey)}', got ${String(lit)}`,
    );
  });

  const typeName = `Union(${discriminatorLiterals.map((l) => String(l)).join(" | ")})`;

  return {
    typeName,
    packedByteCount: (value) => {
      const tagValue = value[String(discriminatorKey)];
      const idx = tagNumbers.indexOf(Number(tagValue));
      if (idx < 0) {
        throw new MemPackEncodeError({
          cause: `${typeName}: unknown tag ${String(tagValue)}`,
        });
      }
      return 1 + memberCodecs[idx]!.packedByteCount(value);
    },
    packInto: (value, view, offset) => {
      const tagValue = value[String(discriminatorKey)];
      const idx = tagNumbers.indexOf(Number(tagValue));
      if (idx < 0) {
        throw new MemPackEncodeError({
          cause: `${typeName}: unknown tag ${String(tagValue)}`,
        });
      }
      const afterTag = tag.packInto(tagNumbers[idx]!, view, offset);
      return memberCodecs[idx]!.packInto(value, view, afterTag);
    },
    unpack: (view, offset) => {
      const { value: tagByte, offset: afterTag } = tag.unpack(view, offset);
      const idx = tagNumbers.indexOf(tagByte);
      if (idx < 0) {
        throw new MemPackDecodeError({
          cause: `${typeName}: unknown tag ${tagByte}`,
        });
      }
      return memberCodecs[idx]!.unpack(view, afterTag);
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
  if (memberSentinels.some((s) => s.length === 0)) return undefined;

  // Find a key present in every member's sentinel list.
  const firstKeys = new Set(memberSentinels[0]!.map((s) => s.key));
  for (const key of firstKeys) {
    const literals: AST.LiteralValue[] = [];
    let ok = true;
    for (const sentinels of memberSentinels) {
      const match = sentinels.find((s) => s.key === key);
      if (!match || typeof match.literal === "symbol") {
        ok = false;
        break;
      }
      literals.push(match.literal);
    }
    if (ok) return { key, literals };
  }
  return undefined;
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
      return text as MemPackCodec<unknown>;
    case "Boolean":
      return bool as MemPackCodec<unknown>;
    case "BigInt":
      return varLen as MemPackCodec<unknown>;
    case "Number":
      // Default Number -> float64; callers wanting integer encoding should
      // annotate their schema or use `Schema.BigInt` for varLen integers.
      return float64 as MemPackCodec<unknown>;
    case "Null":
      return constantCodec("Null", null) as MemPackCodec<unknown>;
    case "Undefined":
    case "Void":
      return constantCodec("Undefined", undefined) as MemPackCodec<unknown>;
    case "Literal":
      return constantCodec(`Literal(${String(ast.literal)})`, ast.literal) as MemPackCodec<unknown>;
    case "Enum": {
      // Enum<A> where A is string | number — MemPack uses a 1-byte Tag for
      // the position in the declared enum list. Requires 0..255 members.
      const entries = ast.enums;
      if (entries.length > 256) {
        throw new Error(`MemPack Enum: ${entries.length} members exceeds 256`);
      }
      const values = entries.map(([, v]) => v);
      return {
        typeName: `Enum(${entries.map(([name]) => name).join(" | ")})`,
        packedByteCount: () => 1,
        packInto: (v, view, offset) => {
          const idx = values.indexOf(v as string | number);
          if (idx < 0) {
            throw new MemPackEncodeError({
              cause: `Enum: value ${String(v)} not a member`,
            });
          }
          return tag.packInto(idx, view, offset);
        },
        unpack: (view, offset) => {
          const { value: idx, offset: next } = tag.unpack(view, offset);
          if (idx < 0 || idx >= values.length) {
            throw new MemPackDecodeError({
              cause: `Enum: tag ${idx} out of range`,
            });
          }
          return { value: values[idx], offset: next };
        },
      } as MemPackCodec<unknown>;
    }
    case "Arrays": {
      // Tuple vs Array distinction: fixed `elements` with no `rest` = tuple
      // (fixed positional concat); otherwise Length-prefixed list.
      if (ast.elements.length > 0 && ast.rest.length === 0) {
        const elementCodecs = ast.elements.map((e) => walk(e));
        return {
          typeName: `Tuple(${elementCodecs.map((c) => c.typeName).join(", ")})`,
          packedByteCount: (vs) => {
            const arr = vs as ReadonlyArray<unknown>;
            let size = 0;
            for (let i = 0; i < elementCodecs.length; i++) {
              size += elementCodecs[i]!.packedByteCount(arr[i]);
            }
            return size;
          },
          packInto: (vs, view, offset) => {
            const arr = vs as ReadonlyArray<unknown>;
            let pos = offset;
            for (let i = 0; i < elementCodecs.length; i++) {
              pos = elementCodecs[i]!.packInto(arr[i], view, pos);
            }
            return pos;
          },
          unpack: (view, offset) => {
            const out = new Array<unknown>(elementCodecs.length);
            let pos = offset;
            for (let i = 0; i < elementCodecs.length; i++) {
              const { value, offset: next } = elementCodecs[i]!.unpack(view, pos);
              out[i] = value;
              pos = next;
            }
            return { value: out, offset: pos };
          },
        } as MemPackCodec<unknown>;
      }
      // Homogeneous rest-element list — `Schema.Array(inner)` lowers to
      // `Arrays` with empty `elements` + single-element `rest` carrying the
      // inner codec.
      if (ast.rest.length !== 1) {
        throw new Error(
          `MemPack Arrays: only fixed tuples and homogeneous lists supported; got ${ast.elements.length} elements + ${ast.rest.length} rest elements`,
        );
      }
      return list(walk(ast.rest[0]!)) as MemPackCodec<unknown>;
    }
    case "Objects": {
      const fields = ast.propertySignatures.map((ps) => walk(ps.type));
      return structCodec(ast, fields) as MemPackCodec<unknown>;
    }
    case "Union": {
      const detected = detectTaggedUnion(ast);
      if (!detected) {
        throw new Error(
          "MemPack Union: untagged unions unsupported. Use Schema.toTaggedUnion or provide a toCodecMemPack annotation.",
        );
      }
      const memberCodecs = ast.types.map((t) => walk(t) as MemPackCodec<Record<string, unknown>>);
      return taggedUnionCodec(
        detected.key,
        detected.literals,
        memberCodecs,
      ) as MemPackCodec<unknown>;
    }
    case "Suspend": {
      // Break recursion cycles with a thunk-wrapping codec whose delegates
      // are resolved lazily exactly like `toArbitrary`'s Suspend branch.
      const get = AST.memoizeThunk(() => walk(ast.thunk()));
      const lazy: MemPackCodec<unknown> = {
        get typeName() {
          return get().typeName;
        },
        packedByteCount: (v) => get().packedByteCount(v),
        packInto: (v, view, offset) => get().packInto(v, view, offset),
        unpack: (view, offset) => get().unpack(view, offset),
      };
      return lazy;
    }
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
    walk(schema.ast) as MemPackCodec<T>,
);

// Export helpers to satisfy consumers that walked via raw AST before.
void length;
