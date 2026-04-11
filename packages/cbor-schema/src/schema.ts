import { BigDecimal, Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { parse } from "./parse";
import { encode } from "./encode";

// ────────────────────────────────────────────────────────────────────────────
// Error types
// ────────────────────────────────────────────────────────────────────────────

export class CborDecodeError extends Schema.TaggedErrorClass<CborDecodeError>()("CborDecodeError", {
  cause: Schema.Defect,
}) {}

export class CborEncodeError extends Schema.TaggedErrorClass<CborEncodeError>()("CborEncodeError", {
  cause: Schema.Defect,
}) {}

// ────────────────────────────────────────────────────────────────────────────
// CborKinds enum — values match CBOR major types (0–7)
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
// CborSchemaType — the CBOR AST
// ────────────────────────────────────────────────────────────────────────────

export type CborSchemaType =
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
      readonly chunks?: readonly CborSchemaType[] | undefined;
    }
  | {
      readonly _tag: CborKinds.Text;
      readonly text: string;
      readonly addInfos?: number | undefined;
      readonly chunks?: readonly CborSchemaType[] | undefined;
    }
  | {
      readonly _tag: CborKinds.Simple;
      readonly value: boolean | null | BigDecimal.BigDecimal | undefined;
      readonly addInfos?: number | undefined;
    }
  | {
      readonly _tag: CborKinds.Array;
      readonly items: readonly CborSchemaType[];
      readonly addInfos?: number | undefined;
    }
  | {
      readonly _tag: CborKinds.Map;
      readonly entries: readonly { readonly k: CborSchemaType; readonly v: CborSchemaType }[];
      readonly addInfos?: number | undefined;
    }
  | {
      readonly _tag: CborKinds.Tag;
      readonly tag: bigint;
      readonly data: CborSchemaType;
      readonly addInfos?: number | undefined;
    };

// ────────────────────────────────────────────────────────────────────────────
// Schema Codecs
// ────────────────────────────────────────────────────────────────────────────

// Reusable constrained schemas
const AddInfos = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 31 }));
const NonNegBigInt = Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n));
const NegBigInt = Schema.BigInt.check(Schema.isLessThanBigInt(0n));

// Leaves: no recursive references
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

// Full recursive schema
export const CborSchema: Schema.Codec<CborSchemaType> = Schema.Union([
  CborLeavesSchema.cases[CborKinds.UInt],
  CborLeavesSchema.cases[CborKinds.NegInt],
  Schema.TaggedStruct(CborKinds.Bytes, {
    bytes: Schema.Uint8Array,
    addInfos: Schema.optional(AddInfos),
    chunks: Schema.optional(
      Schema.Array(Schema.suspend((): Schema.Codec<CborSchemaType> => CborSchema)),
    ),
  }),
  Schema.TaggedStruct(CborKinds.Text, {
    text: Schema.String,
    addInfos: Schema.optional(AddInfos),
    chunks: Schema.optional(
      Schema.Array(Schema.suspend((): Schema.Codec<CborSchemaType> => CborSchema)),
    ),
  }),
  Schema.TaggedStruct(CborKinds.Array, {
    items: Schema.suspend((): Schema.Codec<CborSchemaType> => CborSchema).pipe(Schema.Array),
    addInfos: Schema.optional(AddInfos),
  }),
  Schema.TaggedStruct(CborKinds.Map, {
    entries: Schema.Struct({
      k: Schema.suspend((): Schema.Codec<CborSchemaType> => CborSchema),
      v: Schema.suspend((): Schema.Codec<CborSchemaType> => CborSchema),
    }).pipe(Schema.Array),
    addInfos: Schema.optional(AddInfos),
  }),
  Schema.TaggedStruct(CborKinds.Tag, {
    tag: NonNegBigInt,
    data: Schema.suspend((): Schema.Codec<CborSchemaType> => CborSchema),
    addInfos: Schema.optional(AddInfos),
  }),
  CborLeavesSchema.cases[CborKinds.Simple],
]);

// ────────────────────────────────────────────────────────────────────────────
// Schema codec: Uint8Array ↔ CborSchemaType
// ────────────────────────────────────────────────────────────────────────────

export const transformation: SchemaTransformation.Transformation<CborSchemaType, Uint8Array> =
  SchemaTransformation.transformOrFail({
    decode: (bytes, _options) =>
      parse(bytes).pipe(
        Effect.mapError(
          (e) => new SchemaIssue.InvalidValue(Option.some(bytes), { message: String(e) }),
        ),
      ),
    encode: (ast, _options) =>
      encode(ast).pipe(
        Effect.mapError(
          (e) => new SchemaIssue.InvalidValue(Option.some(ast), { message: String(e) }),
        ),
      ),
  });

export const CborSchemaFromBytes = Schema.Uint8Array.pipe(
  Schema.decodeTo(CborSchema, transformation),
);

// ────────────────────────────────────────────────────────────────────────────
// CBOR type narrowing helpers — runtime-checked discriminated union access
// ────────────────────────────────────────────────────────────────────────────

/** Extract the `num` field from a CBOR UInt node. Throws if not UInt. */
export const cborUint = (node: CborSchemaType, label?: string): bigint => {
  if (node._tag !== CborKinds.UInt) throw new Error(`Expected CBOR UInt${label ? ` for ${label}` : ""}`);
  return node.num;
};

/** Extract the `num` field from a CBOR NegInt node. Throws if not NegInt. */
export const cborNegInt = (node: CborSchemaType, label?: string): bigint => {
  if (node._tag !== CborKinds.NegInt) throw new Error(`Expected CBOR NegInt${label ? ` for ${label}` : ""}`);
  return node.num;
};

/** Extract the `bytes` field from a CBOR Bytes node. Throws if not Bytes. */
export const cborBytes = (node: CborSchemaType, label?: string): Uint8Array => {
  if (node._tag !== CborKinds.Bytes) throw new Error(`Expected CBOR Bytes${label ? ` for ${label}` : ""}`);
  return node.bytes;
};

/** Extract the `text` field from a CBOR Text node. Throws if not Text. */
export const cborText = (node: CborSchemaType, label?: string): string => {
  if (node._tag !== CborKinds.Text) throw new Error(`Expected CBOR Text${label ? ` for ${label}` : ""}`);
  return node.text;
};

/** Extract the `items` array from a CBOR Array node. Throws if not Array. */
export const cborArray = (node: CborSchemaType, label?: string): readonly CborSchemaType[] => {
  if (node._tag !== CborKinds.Array) throw new Error(`Expected CBOR Array${label ? ` for ${label}` : ""}`);
  return node.items;
};

/** Extract the `entries` from a CBOR Map node. Throws if not Map. */
export const cborMap = (node: CborSchemaType, label?: string): readonly { readonly k: CborSchemaType; readonly v: CborSchemaType }[] => {
  if (node._tag !== CborKinds.Map) throw new Error(`Expected CBOR Map${label ? ` for ${label}` : ""}`);
  return node.entries;
};

/** Extract the `value` field from a CBOR Simple node. Throws if not Simple. */
export const cborSimple = (node: CborSchemaType, label?: string): boolean | null | BigDecimal.BigDecimal | undefined => {
  if (node._tag !== CborKinds.Simple) throw new Error(`Expected CBOR Simple${label ? ` for ${label}` : ""}`);
  return node.value;
};

/** Extract boolean from a CBOR Simple node. Throws if not a boolean Simple. */
export const cborBool = (node: CborSchemaType, label?: string): boolean => {
  if (node._tag !== CborKinds.Simple) throw new Error(`Expected CBOR Simple${label ? ` for ${label}` : ""}`);
  if (typeof node.value !== "boolean") throw new Error(`Expected boolean Simple${label ? ` for ${label}` : ""}`);
  return node.value;
};
