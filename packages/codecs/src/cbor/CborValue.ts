import { BigDecimal, Schema } from "effect";

// ────────────────────────────────────────────────────────────────────────────
// CborKinds enum — numeric values = RFC 8949 major types (0–7)
// ────────────────────────────────────────────────────────────────────────────

export enum CborKinds {
  UInt = 0,
  NegInt = 1,
  Bytes = 2,
  Text = 3,
  Array = 4,
  Map = 5,
  Tag = 6,
  Simple = 7,
}

export namespace CborKinds {
  // Header masks
  export const MAJOR_TYPE_SHIFT = 5;
  export const ADD_INFOS_MASK = 0x1f;
  export const BREAK = 0xff;

  // AddInfo thresholds
  export const INLINE_MAX = 23;
  export const AI_1BYTE = 24;
  export const AI_2BYTE = 25;
  export const AI_4BYTE = 26;
  export const AI_8BYTE = 27;
  export const AI_INDEFINITE = 31;

  // Simple values (major type 7 addInfos)
  export const SIMPLE_FALSE = 20;
  export const SIMPLE_TRUE = 21;
  export const SIMPLE_NULL = 22;
  export const SIMPLE_UNDEFINED = 23;

  // Overflow thresholds for canonical encoding
  export const OVERFLOW_1 = 0x100;
  export const OVERFLOW_2 = 0x10000;
  export const OVERFLOW_4 = 0x100000000n;
  export const MAX_UINT64 = 2n ** 64n - 1n;
  export const MIN_NEG_INT64 = -(2n ** 64n);
}

// ────────────────────────────────────────────────────────────────────────────
// CborValue — the CBOR IR (one explicit TS type, matches Effect's Json pattern)
// ────────────────────────────────────────────────────────────────────────────

export type CborValue =
  | { readonly _tag: CborKinds.UInt; readonly num: bigint; readonly addInfos?: number | undefined }
  | {
      readonly _tag: CborKinds.NegInt;
      readonly num: bigint;
      readonly addInfos?: number | undefined;
    }
  | {
      readonly _tag: CborKinds.Bytes;
      readonly bytes: Uint8Array;
      readonly addInfos?: number | undefined;
      readonly chunks?: readonly CborValue[] | undefined;
    }
  | {
      readonly _tag: CborKinds.Text;
      readonly text: string;
      readonly addInfos?: number | undefined;
      readonly chunks?: readonly CborValue[] | undefined;
    }
  | {
      readonly _tag: CborKinds.Simple;
      readonly value: boolean | null | BigDecimal.BigDecimal | undefined;
      readonly addInfos?: number | undefined;
    }
  | {
      readonly _tag: CborKinds.Array;
      readonly items: readonly CborValue[];
      readonly addInfos?: number | undefined;
    }
  | {
      readonly _tag: CborKinds.Map;
      readonly entries: readonly { readonly k: CborValue; readonly v: CborValue }[];
      readonly addInfos?: number | undefined;
    }
  | {
      readonly _tag: CborKinds.Tag;
      readonly tag: bigint;
      readonly data: CborValue;
      readonly addInfos?: number | undefined;
    };

/** Back-compat alias for the former name. */
export type CborSchemaType = CborValue;

// ────────────────────────────────────────────────────────────────────────────
// Schema Codecs — CborValue is a tagged union keyed on numeric CborKinds
// ────────────────────────────────────────────────────────────────────────────

// Reusable constrained schemas
const AddInfos = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 31 }));
const NonNegBigInt = Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n));
const NegBigInt = Schema.BigInt.check(Schema.isLessThanBigInt(0n));

// Leaves: no recursive references — exposed for downstream code that wants to
// match only on scalar variants.
export const CborLeavesSchema = Schema.Union([
  Schema.TaggedStruct(CborKinds.UInt, {
    num: NonNegBigInt,
    addInfos: Schema.optional(AddInfos),
  }),
  Schema.TaggedStruct(CborKinds.NegInt, {
    num: NegBigInt,
    addInfos: Schema.optional(AddInfos),
  }),
  Schema.TaggedStruct(CborKinds.Simple, {
    value: Schema.Union([Schema.Boolean, Schema.Null, Schema.BigDecimal, Schema.Undefined]),
    addInfos: Schema.optional(AddInfos),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

// Full recursive schema. Suspend thunks use `Schema.Codec<CborValue>` (not
// `Schema.Schema<T>`) to propagate the Encoded type through Array/Struct
// composites. The outer const carries NO type annotation — annotating as
// `Schema.Codec<CborValue>` would erase `.cases`/`.guards`/`.isAnyOf`/`.match`
// from `toTaggedUnion`. Inference preserves those utilities.
// (See memory: feedback_recursive_tagged_union.md)
export const CborValue = Schema.Union([
  CborLeavesSchema.cases[CborKinds.UInt],
  CborLeavesSchema.cases[CborKinds.NegInt],
  Schema.TaggedStruct(CborKinds.Bytes, {
    bytes: Schema.Uint8Array,
    addInfos: Schema.optional(AddInfos),
    chunks: Schema.optional(Schema.Array(Schema.suspend((): Schema.Codec<CborValue> => CborValue))),
  }),
  Schema.TaggedStruct(CborKinds.Text, {
    text: Schema.String,
    addInfos: Schema.optional(AddInfos),
    chunks: Schema.optional(Schema.Array(Schema.suspend((): Schema.Codec<CborValue> => CborValue))),
  }),
  Schema.TaggedStruct(CborKinds.Array, {
    items: Schema.suspend((): Schema.Codec<CborValue> => CborValue).pipe(Schema.Array),
    addInfos: Schema.optional(AddInfos),
  }),
  Schema.TaggedStruct(CborKinds.Map, {
    entries: Schema.Struct({
      k: Schema.suspend((): Schema.Codec<CborValue> => CborValue),
      v: Schema.suspend((): Schema.Codec<CborValue> => CborValue),
    }).pipe(Schema.Array),
    addInfos: Schema.optional(AddInfos),
  }),
  Schema.TaggedStruct(CborKinds.Tag, {
    tag: NonNegBigInt,
    data: Schema.suspend((): Schema.Codec<CborValue> => CborValue),
    addInfos: Schema.optional(AddInfos),
  }),
  CborLeavesSchema.cases[CborKinds.Simple],
]).pipe(Schema.toTaggedUnion("_tag"));
