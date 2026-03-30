import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import {
  Cbor,
  CborArray as CborArrayObj,
  CborBytes as CborBytesObj,
  CborMap as CborMapObj,
  CborNegInt as CborNegIntObj,
  CborSimple as CborSimpleObj,
  CborTag as CborTagObj,
  CborText as CborTextObj,
  CborUInt as CborUIntObj,
  isCborObj,
} from "@harmoniclabs/cbor";
import type { CborObj } from "@harmoniclabs/cbor";

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
// CborSchema: Effect-TS tagged union mirroring the CborObj AST
//
// Leaf cases use TaggedUnion for validation + .cases/.match utilities.
// Recursive cases (Array, Map, Tag) use TaggedStruct + suspend.
// ────────────────────────────────────────────────────────────────────────────

const _CborLeaves = Schema.TaggedUnion({
  UInt: { num: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)) },
  NegInt: { num: Schema.BigInt.check(Schema.isLessThanBigInt(0n)) },
  Bytes: { bytes: Schema.Uint8Array },
  Text: { text: Schema.String },
  Simple: {
    value: Schema.Union([Schema.Boolean, Schema.Null, Schema.Number, Schema.Undefined]),
  },
});

export type CborSchemaType =
  | typeof _CborLeaves.cases.UInt.Type
  | typeof _CborLeaves.cases.NegInt.Type
  | typeof _CborLeaves.cases.Bytes.Type
  | typeof _CborLeaves.cases.Text.Type
  | { readonly _tag: "Array"; readonly items: readonly CborSchemaType[] }
  | {
      readonly _tag: "Map";
      readonly entries: readonly {
        readonly k: CborSchemaType;
        readonly v: CborSchemaType;
      }[];
    }
  | {
      readonly _tag: "Tag";
      readonly tag: bigint;
      readonly data: CborSchemaType;
    }
  | typeof _CborLeaves.cases.Simple.Type;

export const CborSchema: Schema.Codec<CborSchemaType> = Schema.Union([
  _CborLeaves.cases.UInt,
  _CborLeaves.cases.NegInt,
  _CborLeaves.cases.Bytes,
  _CborLeaves.cases.Text,
  Schema.TaggedStruct("Array", {
    items: Schema.Array(Schema.suspend((): Schema.Codec<CborSchemaType> => CborSchema)),
  }),
  Schema.TaggedStruct("Map", {
    entries: Schema.Array(
      Schema.Struct({
        k: Schema.suspend((): Schema.Codec<CborSchemaType> => CborSchema),
        v: Schema.suspend((): Schema.Codec<CborSchemaType> => CborSchema),
      }),
    ),
  }),
  Schema.TaggedStruct("Tag", {
    tag: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
    data: Schema.suspend((): Schema.Codec<CborSchemaType> => CborSchema),
  }),
  _CborLeaves.cases.Simple,
]);

// ────────────────────────────────────────────────────────────────────────────
// CborObj ↔ CborSchema isomorphism
// ────────────────────────────────────────────────────────────────────────────

export const cborObjToSchema = (obj: CborObj): CborSchemaType => {
  if (obj instanceof CborUIntObj) {
    return { _tag: "UInt", num: obj.num };
  }
  if (obj instanceof CborNegIntObj) {
    return { _tag: "NegInt", num: obj.num };
  }
  if (obj instanceof CborBytesObj) {
    return { _tag: "Bytes", bytes: obj.bytes };
  }
  if (obj instanceof CborTextObj) {
    return { _tag: "Text", text: obj.text };
  }
  if (obj instanceof CborArrayObj) {
    return { _tag: "Array", items: obj.array.map(cborObjToSchema) };
  }
  if (obj instanceof CborMapObj) {
    return {
      _tag: "Map",
      entries: obj.map.map(({ k, v }) => ({
        k: cborObjToSchema(k),
        v: cborObjToSchema(v),
      })),
    };
  }
  if (obj instanceof CborTagObj) {
    return { _tag: "Tag", tag: obj.tag, data: cborObjToSchema(obj.data) };
  }
  return { _tag: "Simple", value: (obj as CborSimpleObj).simple };
};

export const schemaToCborObj = (value: CborSchemaType): CborObj => {
  switch (value._tag) {
    case "UInt":
      return new CborUIntObj(value.num);
    case "NegInt":
      return new CborNegIntObj(value.num);
    case "Bytes":
      return new CborBytesObj(value.bytes);
    case "Text":
      return new CborTextObj(value.text);
    case "Array":
      return new CborArrayObj(value.items.map(schemaToCborObj));
    case "Map":
      return new CborMapObj(
        value.entries.map(({ k, v }) => ({
          k: schemaToCborObj(k),
          v: schemaToCborObj(v),
        })),
      );
    case "Tag":
      return new CborTagObj(value.tag, schemaToCborObj(value.data));
    case "Simple":
      return new CborSimpleObj(value.value);
  }
};

// ────────────────────────────────────────────────────────────────────────────
// CborObjSchema: Schema.Codec<CborObj>
// ────────────────────────────────────────────────────────────────────────────

export const CborObjSchema = Schema.declare((u: unknown): u is CborObj => isCborObj(u as object), {
  expected: "CborObj",
});

// ────────────────────────────────────────────────────────────────────────────
// CborSchemaFromObj: CborObj ↔ CborSchemaType
//
// Type:    CborSchemaType (Effect-TS tagged union)
// Encoded: CborObj        (class instances)
// ────────────────────────────────────────────────────────────────────────────

export const CborSchemaFromObj = CborObjSchema.pipe(
  Schema.decodeTo(CborSchema, {
    decode: SchemaGetter.transform(cborObjToSchema),
    encode: SchemaGetter.transform(schemaToCborObj),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// CborObjFromBytes: Uint8Array ↔ CborObj
// ────────────────────────────────────────────────────────────────────────────

export const CborObjFromBytes = Schema.Uint8Array.pipe(
  Schema.decodeTo(CborObjSchema, {
    decode: SchemaGetter.transformOrFail((bytes: Uint8Array) =>
      Effect.try({
        try: () => Cbor.parse(bytes),
        catch: (e) => new CborDecodeError({ cause: e }),
      }).pipe(
        Effect.mapError(
          (e) =>
            new SchemaIssue.InvalidValue(Option.none(), {
              message: `CBOR decode failed: ${e}`,
            }),
        ),
      ),
    ),
    encode: SchemaGetter.transformOrFail((obj: CborObj) =>
      Effect.try({
        try: () => Cbor.encode(obj),
        catch: (e) => new CborEncodeError({ cause: e }),
      }).pipe(
        Effect.mapError(
          (e) =>
            new SchemaIssue.InvalidValue(Option.none(), {
              message: `CBOR encode failed: ${e}`,
            }),
        ),
      ),
    ),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// CborSchemaFromBytes: Uint8Array ↔ CborSchemaType (full pipeline)
// ────────────────────────────────────────────────────────────────────────────

export const CborSchemaFromBytes = CborObjFromBytes.pipe(
  Schema.decodeTo(CborSchema, {
    decode: SchemaGetter.transform(cborObjToSchema),
    encode: SchemaGetter.transform(schemaToCborObj),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// CborObj ↔ JS primitive conversions (lossy, for protocol schema compat)
// ────────────────────────────────────────────────────────────────────────────

export const cborToJs = (obj: CborObj): unknown => {
  if (obj instanceof CborUIntObj) return Number(obj.num);
  if (obj instanceof CborNegIntObj) return -Number(obj.num) - 1;
  if (obj instanceof CborBytesObj) return obj.bytes;
  if (obj instanceof CborTextObj) return obj.text;
  if (obj instanceof CborArrayObj) return obj.array.map(cborToJs);
  if (obj instanceof CborMapObj) {
    return Object.fromEntries(obj.map.map(({ k, v }) => [cborToJs(k), cborToJs(v)]));
  }
  if (obj instanceof CborTagObj) return cborToJs(obj.data);
  if (obj instanceof CborSimpleObj) return obj.simple;
  return obj;
};

export const jsToCbor = (value: unknown): CborObj => {
  if (typeof value === "number") {
    return value >= 0 ? new CborUIntObj(value) : new CborNegIntObj(-value - 1);
  }
  if (typeof value === "bigint") {
    return value >= 0n ? new CborUIntObj(value) : new CborNegIntObj(-value - 1n);
  }
  if (typeof value === "string") return new CborTextObj(value);
  if (typeof value === "boolean") {
    return value ? CborSimpleObj.true : CborSimpleObj.false;
  }
  if (value === null || value === undefined) return CborSimpleObj.null;
  if (value instanceof Uint8Array) return new CborBytesObj(value);
  if (Array.isArray(value)) return new CborArrayObj(value.map(jsToCbor));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return new CborMapObj(
      entries.map(([k, v]) => ({
        k: /^\d+$/.test(k) ? new CborUIntObj(parseInt(k, 10)) : jsToCbor(k),
        v: jsToCbor(v),
      })),
    );
  }
  return CborSimpleObj.null;
};

// ────────────────────────────────────────────────────────────────────────────
// CborBytes: Uint8Array ↔ CborObj ↔ JS primitives ↔ ApplicationType
// ────────────────────────────────────────────────────────────────────────────

export const CborBytes = <S extends Schema.Top>(cborSchema: S) =>
  CborObjFromBytes.pipe(
    Schema.decodeTo(cborSchema, {
      decode: SchemaGetter.transform(cborToJs),
      encode: SchemaGetter.transform(jsToCbor),
    }),
  );
