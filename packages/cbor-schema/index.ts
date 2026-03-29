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

export class CborDecodeError extends Schema.TaggedErrorClass<CborDecodeError>()(
    "CborDecodeError",
    { cause: Schema.Defect },
) {}

export class CborEncodeError extends Schema.TaggedErrorClass<CborEncodeError>()(
    "CborEncodeError",
    { cause: Schema.Defect },
) {}

// ────────────────────────────────────────────────────────────────────────────
// CborValue: CBOR AST as an Effect-TS tagged union
// ────────────────────────────────────────────────────────────────────────────

export type CborValue =
    | { readonly _tag: "CborUInt"; readonly value: bigint }
    | { readonly _tag: "CborNegInt"; readonly value: bigint }
    | { readonly _tag: "CborBytes"; readonly bytes: Uint8Array }
    | { readonly _tag: "CborText"; readonly text: string }
    | { readonly _tag: "CborArray"; readonly items: readonly CborValue[] }
    | {
          readonly _tag: "CborMap";
          readonly entries: readonly {
              readonly k: CborValue;
              readonly v: CborValue;
          }[];
      }
    | { readonly _tag: "CborTag"; readonly tag: bigint; readonly data: CborValue }
    | {
          readonly _tag: "CborSimple";
          readonly value: boolean | null | number | undefined;
      };

// Leaf schemas (non-recursive)
const CborUInt = Schema.TaggedStruct("CborUInt", { value: Schema.BigInt });
const CborNegInt = Schema.TaggedStruct("CborNegInt", { value: Schema.BigInt });
const CborBytes = Schema.TaggedStruct("CborBytes", { bytes: Schema.Uint8Array });
const CborText = Schema.TaggedStruct("CborText", { text: Schema.String });
const CborSimple = Schema.TaggedStruct("CborSimple", {
    value: Schema.Union([Schema.Boolean, Schema.Null, Schema.Number, Schema.Undefined]),
});

// Self-referencing recursive schema — follows the Effect-TS pattern from
// Schema.test.ts where the variable annotation breaks the inference cycle.
export const CborValueSchema: Schema.Codec<CborValue> = Schema.Union([
    CborUInt,
    CborNegInt,
    CborBytes,
    CborText,
    Schema.TaggedStruct("CborArray", {
        items: Schema.Array(
            Schema.suspend((): Schema.Codec<CborValue> => CborValueSchema),
        ),
    }),
    Schema.TaggedStruct("CborMap", {
        entries: Schema.Array(
            Schema.Struct({
                k: Schema.suspend((): Schema.Codec<CborValue> => CborValueSchema),
                v: Schema.suspend((): Schema.Codec<CborValue> => CborValueSchema),
            }),
        ),
    }),
    Schema.TaggedStruct("CborTag", {
        tag: Schema.BigInt,
        data: Schema.suspend((): Schema.Codec<CborValue> => CborValueSchema),
    }),
    CborSimple,
]);

export { CborUInt, CborNegInt, CborBytes, CborText, CborSimple };

// ────────────────────────────────────────────────────────────────────────────
// CborObj ↔ CborValue isomorphism
// ────────────────────────────────────────────────────────────────────────────

export const cborObjToValue = (obj: CborObj): CborValue => {
    if (obj instanceof CborUIntObj)
        return { _tag: "CborUInt", value: obj.num };
    if (obj instanceof CborNegIntObj)
        return { _tag: "CborNegInt", value: obj.num };
    if (obj instanceof CborBytesObj)
        return { _tag: "CborBytes", bytes: obj.bytes };
    if (obj instanceof CborTextObj)
        return { _tag: "CborText", text: obj.text };
    if (obj instanceof CborArrayObj)
        return { _tag: "CborArray", items: obj.array.map(cborObjToValue) };
    if (obj instanceof CborMapObj)
        return {
            _tag: "CborMap",
            entries: obj.map.map(({ k, v }) => ({
                k: cborObjToValue(k),
                v: cborObjToValue(v),
            })),
        };
    if (obj instanceof CborTagObj)
        return { _tag: "CborTag", tag: obj.tag, data: cborObjToValue(obj.data) };
    return { _tag: "CborSimple", value: (obj as CborSimpleObj).simple };
};

export const valueToCborObj = (value: CborValue): CborObj => {
    switch (value._tag) {
        case "CborUInt":
            return new CborUIntObj(value.value);
        case "CborNegInt":
            return new CborNegIntObj(value.value);
        case "CborBytes":
            return new CborBytesObj(value.bytes);
        case "CborText":
            return new CborTextObj(value.text);
        case "CborArray":
            return new CborArrayObj(value.items.map(valueToCborObj));
        case "CborMap":
            return new CborMapObj(
                value.entries.map(({ k, v }) => ({
                    k: valueToCborObj(k),
                    v: valueToCborObj(v),
                })),
            );
        case "CborTag":
            return new CborTagObj(value.tag, valueToCborObj(value.data));
        case "CborSimple":
            return new CborSimpleObj(value.value);
    }
};

// ────────────────────────────────────────────────────────────────────────────
// CborObj schema (validates class instances from @harmoniclabs/cbor)
// ────────────────────────────────────────────────────────────────────────────

const CborObjSchema = Schema.declare(
    (u: unknown): u is CborObj => isCborObj(u as object),
    { expected: "CborObj" },
);

// ────────────────────────────────────────────────────────────────────────────
// CborObj ↔ CborValue codec
//
// Type:    CborValue  (Effect-TS tagged union)
// Encoded: CborObj    (class instances from @harmoniclabs/cbor)
// ────────────────────────────────────────────────────────────────────────────

export const CborValueFromObj = CborObjSchema.pipe(
    Schema.decodeTo(CborValueSchema, {
        decode: SchemaGetter.transform(cborObjToValue),
        encode: SchemaGetter.transform(valueToCborObj),
    }),
);

// ────────────────────────────────────────────────────────────────────────────
// Uint8Array ↔ CborObj codec
//
// Type:    CborObj
// Encoded: Uint8Array (raw CBOR bytes)
// ────────────────────────────────────────────────────────────────────────────

export const CborObjFromBytes = Schema.Uint8Array.pipe(
    Schema.decodeTo(CborObjSchema, {
        decode: SchemaGetter.transformOrFail((bytes: Uint8Array) =>
            Effect.try({
                try: () => Cbor.parse(bytes),
                catch: (e) => new CborDecodeError({ cause: e }),
            }).pipe(
                Effect.mapError((e) =>
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
                Effect.mapError((e) =>
                    new SchemaIssue.InvalidValue(Option.none(), {
                        message: `CBOR encode failed: ${e}`,
                    }),
                ),
            ),
        ),
    }),
);

// ────────────────────────────────────────────────────────────────────────────
// Uint8Array ↔ CborValue codec (full wire-format convenience)
//
// Compose: Uint8Array → CborObj → CborValue
// ────────────────────────────────────────────────────────────────────────────

export const CborValueFromBytes = CborObjFromBytes.pipe(
    Schema.decodeTo(CborValueSchema, {
        decode: SchemaGetter.transform(cborObjToValue),
        encode: SchemaGetter.transform(valueToCborObj),
    }),
);

// ────────────────────────────────────────────────────────────────────────────
// CborSchema: compose a user schema on top of CborValue from bytes
//
// Given a schema S whose Encoded type accepts CborValue,
// produces: Uint8Array ↔ CborObj ↔ CborValue ↔ S.Type
// ────────────────────────────────────────────────────────────────────────────

export const CborSchema = <S extends Schema.Top>(schema: S) =>
    CborValueFromBytes.pipe(Schema.decodeTo(schema));
