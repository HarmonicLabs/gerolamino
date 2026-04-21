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
import { CborKinds, type CborSchemaType } from "codecs";
import {
  uint,
  negInt,
  cborBytes,
  arr,
  expectArray,
  expectUint,
  expectBytes,
} from "../core/cbor-utils.ts";

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

export function decodePlutusData(
  cbor: CborSchemaType,
): Effect.Effect<PlutusData, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    switch (cbor._tag) {
      // Integer (unsigned)
      case CborKinds.UInt:
        return { _tag: PlutusDataKind.Int as const, value: cbor.num };

      // Integer (negative)
      case CborKinds.NegInt:
        return { _tag: PlutusDataKind.Int as const, value: cbor.num };

      // Bytes
      case CborKinds.Bytes:
        return { _tag: PlutusDataKind.Bytes as const, value: cbor.bytes };

      // Array → List
      case CborKinds.Array: {
        const items = yield* Effect.all(cbor.items.map(decodePlutusData));
        return { _tag: PlutusDataKind.List as const, items };
      }

      // Map → Map
      case CborKinds.Map: {
        const entries = yield* Effect.all(
          cbor.entries.map((e) =>
            Effect.all([decodePlutusData(e.k), decodePlutusData(e.v)] as const),
          ),
        );
        return { _tag: PlutusDataKind.Map as const, entries };
      }

      // Tag → Constr or Bignum
      case CborKinds.Tag: {
        const tagNum = Number(cbor.tag);

        // Tag(2) = positive bignum
        if (tagNum === 2 && cbor.data._tag === CborKinds.Bytes) {
          let n = 0n;
          for (const b of cbor.data.bytes) n = (n << 8n) | BigInt(b);
          return { _tag: PlutusDataKind.Int as const, value: n };
        }

        // Tag(3) = negative bignum (-1 - n)
        if (tagNum === 3 && cbor.data._tag === CborKinds.Bytes) {
          let n = 0n;
          for (const b of cbor.data.bytes) n = (n << 8n) | BigInt(b);
          return { _tag: PlutusDataKind.Int as const, value: -1n - n };
        }

        // Tag(121..127) = Constr with small tag (0..6)
        if (tagNum >= 121 && tagNum <= 127) {
          const fieldsArr = yield* expectArray(cbor.data, `Constr(${tagNum - 121})`);
          const fields = yield* Effect.all(fieldsArr.map(decodePlutusData));
          return { _tag: PlutusDataKind.Constr as const, constrTag: BigInt(tagNum - 121), fields };
        }

        // Tag(1280..1400) = Constr with medium tag (7..127)
        if (tagNum >= 1280 && tagNum <= 1400) {
          const fieldsArr = yield* expectArray(cbor.data, `Constr(${tagNum - 1280 + 7})`);
          const fields = yield* Effect.all(fieldsArr.map(decodePlutusData));
          return {
            _tag: PlutusDataKind.Constr as const,
            constrTag: BigInt(tagNum - 1280 + 7),
            fields,
          };
        }

        // Tag(102) = general Constr [tag, fields]
        if (tagNum === 102) {
          const constrItems = yield* expectArray(cbor.data, "Constr(general)", 2);
          const constrTag = yield* expectUint(constrItems[0]!, "Constr.tag");
          const fieldsArr = yield* expectArray(constrItems[1]!, "Constr.fields");
          const fields = yield* Effect.all(fieldsArr.map(decodePlutusData));
          return { _tag: PlutusDataKind.Constr as const, constrTag, fields };
        }

        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: `PlutusData: unsupported CBOR tag ${tagNum}`,
          }),
        );
      }

      default:
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: `PlutusData: unexpected CBOR kind ${cbor._tag}`,
          }),
        );
    }
  });
}

// ---------------------------------------------------------------------------
// CBOR Encoder (recursive) — uses PlutusData.match for exhaustive dispatch
// ---------------------------------------------------------------------------

export const encodePlutusData: (data: PlutusData) => CborSchemaType = PlutusData.match({
  [PlutusDataKind.Int]: (d): CborSchemaType => (d.value >= 0n ? uint(d.value) : negInt(d.value)),

  [PlutusDataKind.Bytes]: (d): CborSchemaType => cborBytes(d.value),

  [PlutusDataKind.List]: (d): CborSchemaType => arr(...d.items.map(encodePlutusData)),

  [PlutusDataKind.Map]: (d): CborSchemaType => ({
    _tag: CborKinds.Map,
    entries: d.entries.map(([k, v]) => ({
      k: encodePlutusData(k),
      v: encodePlutusData(v),
    })),
  }),

  [PlutusDataKind.Constr]: (d): CborSchemaType => {
    const tag = Number(d.constrTag);
    const fields: CborSchemaType = arr(...d.fields.map(encodePlutusData));
    // Small tag: 0..6 → Tag(121+n)
    if (tag >= 0 && tag <= 6) return { _tag: CborKinds.Tag, tag: BigInt(121 + tag), data: fields };
    // Medium tag: 7..127 → Tag(1280+n-7)
    if (tag >= 7 && tag <= 127)
      return { _tag: CborKinds.Tag, tag: BigInt(1280 + tag - 7), data: fields };
    // General: Tag(102, [tag, fields])
    return {
      _tag: CborKinds.Tag,
      tag: 102n,
      data: arr(uint(d.constrTag), fields),
    };
  },
});
