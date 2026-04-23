/**
 * PlutusData — recursive data type used in Plutus smart contract execution.
 *
 * CBOR encoding:
 * - Constr(tag, fields): Tag(121+n) for n=0..6, Tag(1280+n) for n=7..127, Tag(102, [tag, fields]) for general
 * - Map: CBOR Map of PlutusData → PlutusData
 * - List: CBOR Array of PlutusData
 * - Int: CBOR UInt or NegInt (arbitrary precision, also Tag(2)/Tag(3) bignums)
 * - Bytes: CBOR Bytes
 *
 * Reference: cardano-ledger-ts/src/eras/common/ledger/Data.ts
 *            cardano-ledger/libs/cardano-ledger-core/src/Cardano/Ledger/Plutus/Data.hs
 */
import { Effect, Option, Schema, SchemaIssue } from "effect";
import {
  CborKinds,
  type CborSchemaType,
  type CborValue,
  CborValue as CborValueSchema,
} from "codecs";
import {
  uint,
  negInt,
  cborBytes,
  cborMap,
  cborTagged,
  arr,
  expectArray,
  expectUint,
} from "../core/cbor-utils.ts";

// ---------------------------------------------------------------------------
// Module-local dispatch-failure helper for CborValueSchema.match
// ---------------------------------------------------------------------------

const invalid = <T>(value: T, message: string): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message }));

const failOthers = (expected: string) =>
  ({
    [CborKinds.UInt]: (v: CborValue) => invalid(v, `${expected}: unexpected UInt`),
    [CborKinds.NegInt]: (v: CborValue) => invalid(v, `${expected}: unexpected NegInt`),
    [CborKinds.Bytes]: (v: CborValue) => invalid(v, `${expected}: unexpected Bytes`),
    [CborKinds.Text]: (v: CborValue) => invalid(v, `${expected}: unexpected Text`),
    [CborKinds.Array]: (v: CborValue) => invalid(v, `${expected}: unexpected Array`),
    [CborKinds.Map]: (v: CborValue) => invalid(v, `${expected}: unexpected Map`),
    [CborKinds.Tag]: (v: CborValue) => invalid(v, `${expected}: unexpected Tag`),
    [CborKinds.Simple]: (v: CborValue) => invalid(v, `${expected}: unexpected Simple`),
  }) as const;

// ---------------------------------------------------------------------------
// PlutusData — recursive Schema using Schema.suspend
// ---------------------------------------------------------------------------

export enum PlutusDataKind {
  Constr = "Constr",
  Map = "Map",
  List = "List",
  Int = "Int",
  Bytes = "Bytes",
}

export type PlutusData =
  | {
      readonly _tag: PlutusDataKind.Constr;
      readonly constrTag: bigint;
      readonly fields: ReadonlyArray<PlutusData>;
    }
  | {
      readonly _tag: PlutusDataKind.Map;
      readonly entries: ReadonlyArray<readonly [PlutusData, PlutusData]>;
    }
  | { readonly _tag: PlutusDataKind.List; readonly items: ReadonlyArray<PlutusData> }
  | { readonly _tag: PlutusDataKind.Int; readonly value: bigint }
  | { readonly _tag: PlutusDataKind.Bytes; readonly value: Uint8Array };

// Recursive Schema using suspend — references _PlutusDataSchema lazily.
// Schema.Codec<T> default is Codec<T, T, never, never>, which keeps Encoded = T
// and allows toCodecCbor to propagate through Schema.Array(PlutusDataRef).
// Schema.Schema<T> would leave Encoded = unknown and break toCodecCbor derivation.
const PlutusDataRef = Schema.suspend((): Schema.Codec<PlutusData> => _PlutusDataSchema);

// Internal schema with full inferred type (preserves .match(), .guards, .isAnyOf())
const _PlutusDataSchema = Schema.Union([
  Schema.TaggedStruct(PlutusDataKind.Constr, {
    constrTag: Schema.BigInt,
    fields: Schema.Array(PlutusDataRef),
  }),
  Schema.TaggedStruct(PlutusDataKind.Map, {
    entries: Schema.Array(Schema.Tuple([PlutusDataRef, PlutusDataRef])),
  }),
  Schema.TaggedStruct(PlutusDataKind.List, {
    items: Schema.Array(PlutusDataRef),
  }),
  Schema.TaggedStruct(PlutusDataKind.Int, { value: Schema.BigInt }),
  Schema.TaggedStruct(PlutusDataKind.Bytes, { value: Schema.Uint8Array }),
]).pipe(Schema.toTaggedUnion("_tag"));

// Re-export with inferred type so .match()/.guards/.isAnyOf() are accessible
export const PlutusData = _PlutusDataSchema;

// ---------------------------------------------------------------------------
// CBOR Decoder (recursive)
// ---------------------------------------------------------------------------

// Big-endian byte sequence → unsigned bigint (RFC 8949 §3.4.3 bignum payload).
const bytesToBigInt = (bytes: Uint8Array): bigint =>
  bytes.reduce<bigint>((n, b) => (n << 8n) | BigInt(b), 0n);

const decodeBignumTag = (
  tagNum: number,
  data: CborSchemaType,
): Effect.Effect<PlutusData, SchemaIssue.Issue> => {
  if (!CborValueSchema.guards[CborKinds.Bytes](data)) {
    return invalid(data, `PlutusData: bignum Tag(${tagNum}) expects Bytes payload`);
  }
  const n = bytesToBigInt(data.bytes);
  return Effect.succeed({
    _tag: PlutusDataKind.Int as const,
    value: tagNum === 3 ? -1n - n : n,
  });
};

const decodeConstrFields = (
  data: CborSchemaType,
  ctx: string,
  constrTag: bigint,
): Effect.Effect<PlutusData, SchemaIssue.Issue> =>
  expectArray(data, ctx).pipe(
    Effect.flatMap((fieldsArr) => Effect.all(fieldsArr.map(decodePlutusData))),
    Effect.map((fields) => ({ _tag: PlutusDataKind.Constr as const, constrTag, fields })),
  );

const decodeGeneralConstr = (
  data: CborSchemaType,
): Effect.Effect<PlutusData, SchemaIssue.Issue> =>
  expectArray(data, "Constr(general)", 2).pipe(
    Effect.flatMap((items) =>
      Effect.all({
        constrTag: expectUint(items[0]!, "Constr.tag"),
        fieldsArr: expectArray(items[1]!, "Constr.fields"),
      }),
    ),
    Effect.flatMap(({ constrTag, fieldsArr }) =>
      Effect.all(fieldsArr.map(decodePlutusData)).pipe(
        Effect.map((fields) => ({ _tag: PlutusDataKind.Constr as const, constrTag, fields })),
      ),
    ),
  );

// Tag dispatch: Tag(2/3) bignums, Tag(121..127) small Constr, Tag(1280..1400)
// medium Constr, Tag(102) general Constr.
const decodePlutusTag = (
  cbor: Extract<CborValue, { _tag: typeof CborKinds.Tag }>,
): Effect.Effect<PlutusData, SchemaIssue.Issue> => {
  const tagNum = Number(cbor.tag);
  if (tagNum === 2 || tagNum === 3) return decodeBignumTag(tagNum, cbor.data);
  if (tagNum >= 121 && tagNum <= 127) {
    return decodeConstrFields(cbor.data, `Constr(${tagNum - 121})`, BigInt(tagNum - 121));
  }
  if (tagNum >= 1280 && tagNum <= 1400) {
    return decodeConstrFields(
      cbor.data,
      `Constr(${tagNum - 1280 + 7})`,
      BigInt(tagNum - 1280 + 7),
    );
  }
  if (tagNum === 102) return decodeGeneralConstr(cbor.data);
  return invalid(cbor, `PlutusData: unsupported CBOR tag ${tagNum}`);
};

const decodePlutusMapEntry = (e: { k: CborSchemaType; v: CborSchemaType }) =>
  Effect.all([decodePlutusData(e.k), decodePlutusData(e.v)] as const);

export function decodePlutusData(
  cbor: CborSchemaType,
): Effect.Effect<PlutusData, SchemaIssue.Issue> {
  return CborValueSchema.match({
    ...failOthers("PlutusData"),
    [CborKinds.UInt]: (c): Effect.Effect<PlutusData, SchemaIssue.Issue> =>
      Effect.succeed({ _tag: PlutusDataKind.Int as const, value: c.num }),
    [CborKinds.NegInt]: (c): Effect.Effect<PlutusData, SchemaIssue.Issue> =>
      Effect.succeed({ _tag: PlutusDataKind.Int as const, value: c.num }),
    [CborKinds.Bytes]: (c): Effect.Effect<PlutusData, SchemaIssue.Issue> =>
      Effect.succeed({ _tag: PlutusDataKind.Bytes as const, value: c.bytes }),
    [CborKinds.Array]: (c): Effect.Effect<PlutusData, SchemaIssue.Issue> =>
      Effect.all(c.items.map(decodePlutusData)).pipe(
        Effect.map((items) => ({ _tag: PlutusDataKind.List as const, items })),
      ),
    [CborKinds.Map]: (c): Effect.Effect<PlutusData, SchemaIssue.Issue> =>
      Effect.all(c.entries.map(decodePlutusMapEntry)).pipe(
        Effect.map((entries) => ({ _tag: PlutusDataKind.Map as const, entries })),
      ),
    [CborKinds.Tag]: decodePlutusTag,
  })(cbor);
}

// ---------------------------------------------------------------------------
// CBOR Encoder (recursive) — uses PlutusData.match for exhaustive dispatch
// ---------------------------------------------------------------------------

export const encodePlutusData: (data: PlutusData) => CborSchemaType = PlutusData.match({
  [PlutusDataKind.Int]: (d): CborSchemaType => (d.value >= 0n ? uint(d.value) : negInt(d.value)),

  [PlutusDataKind.Bytes]: (d): CborSchemaType => cborBytes(d.value),

  [PlutusDataKind.List]: (d): CborSchemaType => arr(...d.items.map(encodePlutusData)),

  [PlutusDataKind.Map]: (d): CborSchemaType =>
    cborMap(
      d.entries.map(([k, v]) => ({
        k: encodePlutusData(k),
        v: encodePlutusData(v),
      })),
    ),

  [PlutusDataKind.Constr]: (d): CborSchemaType => {
    const tag = Number(d.constrTag);
    const fields: CborSchemaType = arr(...d.fields.map(encodePlutusData));
    // Small tag: 0..6 → Tag(121+n)
    if (tag >= 0 && tag <= 6) return cborTagged(121 + tag, fields);
    // Medium tag: 7..127 → Tag(1280+n-7)
    if (tag >= 7 && tag <= 127) return cborTagged(1280 + tag - 7, fields);
    // General: Tag(102, [tag, fields])
    return cborTagged(102n, arr(uint(d.constrTag), fields));
  },
});
