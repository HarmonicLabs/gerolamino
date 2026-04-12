/**
 * TxMetadata and AuxiliaryData decoders.
 *
 * TxMetadata: Map<bigint, Metadatum> where Metadatum is recursive:
 *   Int | Bytes | Text | List<Metadatum> | Map<Metadatum, Metadatum>
 *
 * AuxiliaryData formats:
 * - Shelley: bare TxMetadata map (no tag)
 * - Alonzo+: Tag(259, Map{0?: metadata, 1?: nativeScripts[], 2?: PlutusV1[], 3?: V2[], 4?: V3[]})
 *
 * Reference: cardano-ledger-ts/src/tx/metadata/TxMetadatum.ts
 *            cardano-ledger/libs/cardano-ledger-core/src/Cardano/Ledger/Metadata.hs
 */
import { Effect, Option, Schema, SchemaIssue } from "effect";
import { CborKinds, type CborSchemaType } from "cbor-schema";
import {
  uint,
  negInt,
  cborBytes,
  cborText,
  arr,
  expectMap,
  expectUint,
  getMapValue,
} from "../core/cbor-utils.ts";

// ---------------------------------------------------------------------------
// Metadatum — recursive Schema
// ---------------------------------------------------------------------------

export enum MetadatumKind {
  Int = "MetaInt",
  Bytes = "MetaBytes",
  Text = "MetaText",
  List = "MetaList",
  Map = "MetaMap",
}

export type Metadatum =
  | { readonly _tag: MetadatumKind.Int; readonly value: bigint }
  | { readonly _tag: MetadatumKind.Bytes; readonly value: Uint8Array }
  | { readonly _tag: MetadatumKind.Text; readonly value: string }
  | { readonly _tag: MetadatumKind.List; readonly items: ReadonlyArray<Metadatum> }
  | {
      readonly _tag: MetadatumKind.Map;
      readonly entries: ReadonlyArray<readonly [Metadatum, Metadatum]>;
    };

const MetadatumRef = Schema.suspend((): Schema.Schema<Metadatum> => Metadatum);

export const Metadatum: Schema.Schema<Metadatum> = Schema.Union([
  Schema.TaggedStruct(MetadatumKind.Int, { value: Schema.BigInt }),
  Schema.TaggedStruct(MetadatumKind.Bytes, { value: Schema.Uint8Array }),
  Schema.TaggedStruct(MetadatumKind.Text, { value: Schema.String }),
  Schema.TaggedStruct(MetadatumKind.List, { items: Schema.Array(MetadatumRef) }),
  Schema.TaggedStruct(MetadatumKind.Map, {
    entries: Schema.Array(Schema.Tuple([MetadatumRef, MetadatumRef])),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

// ---------------------------------------------------------------------------
// TxMetadata Schema — Array of {label, value} entries
// ---------------------------------------------------------------------------

export const MetadataEntry = Schema.Struct({
  label: Schema.BigInt,
  value: Metadatum,
});
export type MetadataEntry = typeof MetadataEntry.Type;

export const TxMetadata = Schema.Struct({
  entries: Schema.Array(MetadataEntry),
});
export type TxMetadata = typeof TxMetadata.Type;

// ---------------------------------------------------------------------------
// AuxiliaryData Schema
// ---------------------------------------------------------------------------

export const AuxiliaryData = Schema.Struct({
  metadata: Schema.optional(TxMetadata),
  nativeScripts: Schema.optional(Schema.Array(Schema.Uint8Array)),
  plutusV1Scripts: Schema.optional(Schema.Array(Schema.Uint8Array)),
  plutusV2Scripts: Schema.optional(Schema.Array(Schema.Uint8Array)),
  plutusV3Scripts: Schema.optional(Schema.Array(Schema.Uint8Array)),
});
export type AuxiliaryData = typeof AuxiliaryData.Type;

// ---------------------------------------------------------------------------
// Metadatum CBOR decoder (recursive)
// ---------------------------------------------------------------------------

export function decodeMetadatum(cbor: CborSchemaType): Effect.Effect<Metadatum, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    switch (cbor._tag) {
      case CborKinds.UInt:
        return { _tag: MetadatumKind.Int as const, value: cbor.num };

      case CborKinds.NegInt:
        return { _tag: MetadatumKind.Int as const, value: cbor.num };

      case CborKinds.Bytes:
        return { _tag: MetadatumKind.Bytes as const, value: cbor.bytes };

      case CborKinds.Text:
        return { _tag: MetadatumKind.Text as const, value: cbor.text };

      case CborKinds.Array: {
        // Could be a chunked Bytes/Text array or a genuine List
        if (cbor.items.length > 0 && cbor.items.every((i) => i._tag === CborKinds.Bytes)) {
          const totalLen = cbor.items.reduce(
            (sum, i) => sum + (i._tag === CborKinds.Bytes ? i.bytes.length : 0),
            0,
          );
          const result = new Uint8Array(totalLen);
          let offset = 0;
          for (const item of cbor.items) {
            if (item._tag === CborKinds.Bytes) {
              result.set(item.bytes, offset);
              offset += item.bytes.length;
            }
          }
          return { _tag: MetadatumKind.Bytes as const, value: result };
        }
        if (cbor.items.length > 0 && cbor.items.every((i) => i._tag === CborKinds.Text)) {
          const text = cbor.items.map((i) => (i._tag === CborKinds.Text ? i.text : "")).join("");
          return { _tag: MetadatumKind.Text as const, value: text };
        }
        const items = yield* Effect.all(cbor.items.map(decodeMetadatum));
        return { _tag: MetadatumKind.List as const, items };
      }

      case CborKinds.Map: {
        const entries = yield* Effect.all(
          cbor.entries.map((e) =>
            Effect.all([decodeMetadatum(e.k), decodeMetadatum(e.v)] as const),
          ),
        );
        return { _tag: MetadatumKind.Map as const, entries };
      }

      default:
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: `Metadatum: unexpected CBOR kind ${cbor._tag}`,
          }),
        );
    }
  });
}

// ---------------------------------------------------------------------------
// Metadatum CBOR encoder (recursive — .match() unavailable due to Schema.suspend)
// ---------------------------------------------------------------------------

export function encodeMetadatum(m: Metadatum): CborSchemaType {
  switch (m._tag) {
    case MetadatumKind.Int:
      return m.value >= 0n ? uint(m.value) : negInt(m.value);
    case MetadatumKind.Bytes:
      return cborBytes(m.value);
    case MetadatumKind.Text:
      return cborText(m.value);
    case MetadatumKind.List:
      return arr(...m.items.map(encodeMetadatum));
    case MetadatumKind.Map:
      return {
        _tag: CborKinds.Map,
        entries: m.entries.map(([k, v]) => ({
          k: encodeMetadatum(k),
          v: encodeMetadatum(v),
        })),
      };
  }
}

// ---------------------------------------------------------------------------
// TxMetadata CBOR encoder
// ---------------------------------------------------------------------------

export function encodeTxMetadata(meta: TxMetadata): CborSchemaType {
  return {
    _tag: CborKinds.Map,
    entries: meta.entries.map((e) => ({
      k: uint(e.label),
      v: encodeMetadatum(e.value),
    })),
  };
}

// ---------------------------------------------------------------------------
// AuxiliaryData CBOR encoder — always Alonzo+ format: Tag(259, Map{...})
// ---------------------------------------------------------------------------

function encodeScriptArray(scripts: ReadonlyArray<Uint8Array>): CborSchemaType {
  return arr(...scripts.map(cborBytes));
}

export function encodeAuxiliaryData(aux: AuxiliaryData): CborSchemaType {
  const entries: Array<{ k: CborSchemaType; v: CborSchemaType }> = [];
  if (aux.metadata) {
    entries.push({ k: uint(0), v: encodeTxMetadata(aux.metadata) });
  }
  if (aux.nativeScripts) {
    entries.push({ k: uint(1), v: encodeScriptArray(aux.nativeScripts) });
  }
  if (aux.plutusV1Scripts) {
    entries.push({ k: uint(2), v: encodeScriptArray(aux.plutusV1Scripts) });
  }
  if (aux.plutusV2Scripts) {
    entries.push({ k: uint(3), v: encodeScriptArray(aux.plutusV2Scripts) });
  }
  if (aux.plutusV3Scripts) {
    entries.push({ k: uint(4), v: encodeScriptArray(aux.plutusV3Scripts) });
  }
  return { _tag: CborKinds.Tag, tag: 259n, data: { _tag: CborKinds.Map, entries } };
}

// ---------------------------------------------------------------------------
// TxMetadata CBOR decoder
// ---------------------------------------------------------------------------

export function decodeTxMetadata(
  cbor: CborSchemaType,
): Effect.Effect<TxMetadata, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const mapEntries = yield* expectMap(cbor, "TxMetadata");
    const entries = yield* Effect.all(
      mapEntries.map((e) =>
        Effect.gen(function* () {
          const label = yield* expectUint(e.k, "TxMetadata.label");
          const value = yield* decodeMetadatum(e.v);
          return { label, value };
        }),
      ),
    );
    return { entries };
  });
}

// ---------------------------------------------------------------------------
// AuxiliaryData CBOR decoder
// ---------------------------------------------------------------------------

function extractScriptArray(
  cbor: CborSchemaType | undefined,
): ReadonlyArray<Uint8Array> | undefined {
  if (!cbor || cbor._tag !== CborKinds.Array) return undefined;
  return cbor.items
    .filter(
      (i): i is Extract<CborSchemaType, { _tag: typeof CborKinds.Bytes }> =>
        i._tag === CborKinds.Bytes,
    )
    .map((i) => i.bytes);
}

export function decodeAuxiliaryData(
  cbor: CborSchemaType,
): Effect.Effect<AuxiliaryData, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    // Alonzo+ format: Tag(259, Map{...})
    if (cbor._tag === CborKinds.Tag && cbor.tag === 259n) {
      const mapEntries = yield* expectMap(cbor.data, "AuxiliaryData(Alonzo+)");
      const metaCbor = getMapValue(mapEntries, 0);
      const metadata = metaCbor ? yield* decodeTxMetadata(metaCbor) : undefined;
      return {
        metadata,
        nativeScripts: extractScriptArray(getMapValue(mapEntries, 1)),
        plutusV1Scripts: extractScriptArray(getMapValue(mapEntries, 2)),
        plutusV2Scripts: extractScriptArray(getMapValue(mapEntries, 3)),
        plutusV3Scripts: extractScriptArray(getMapValue(mapEntries, 4)),
      };
    }

    // Shelley format: bare metadata map
    if (cbor._tag === CborKinds.Map) {
      const metadata = yield* decodeTxMetadata(cbor);
      return {
        metadata,
        nativeScripts: undefined,
        plutusV1Scripts: undefined,
        plutusV2Scripts: undefined,
        plutusV3Scripts: undefined,
      };
    }

    // Shelley/Allegra array format: [metadata, nativeScripts]
    if (cbor._tag === CborKinds.Array && cbor.items.length === 2) {
      const metadata = yield* decodeTxMetadata(cbor.items[0]!);
      return {
        metadata,
        nativeScripts: extractScriptArray(cbor.items[1]),
        plutusV1Scripts: undefined,
        plutusV2Scripts: undefined,
        plutusV3Scripts: undefined,
      };
    }

    return yield* Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: `AuxiliaryData: expected Tag(259, Map), Map, or Array, got ${cbor._tag}`,
      }),
    );
  });
}
