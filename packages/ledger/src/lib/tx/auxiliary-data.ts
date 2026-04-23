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
  cborText,
  arr,
  cborMap,
  cborTagged,
  expectMap,
  expectUint,
  getMapValue,
  mapEntry,
} from "../core/cbor-utils.ts";

// ---------------------------------------------------------------------------
// Module-local dispatch-failure helper for CborValueSchema.match
// ---------------------------------------------------------------------------

const invalid = <T>(value: T, message: string): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message }));

const failOthers = (expected: string) =>
  ({
    [CborKinds.UInt]: (v: CborValue) => invalid(v, `${expected}, got UInt`),
    [CborKinds.NegInt]: (v: CborValue) => invalid(v, `${expected}, got NegInt`),
    [CborKinds.Bytes]: (v: CborValue) => invalid(v, `${expected}, got Bytes`),
    [CborKinds.Text]: (v: CborValue) => invalid(v, `${expected}, got Text`),
    [CborKinds.Array]: (v: CborValue) => invalid(v, `${expected}, got Array`),
    [CborKinds.Map]: (v: CborValue) => invalid(v, `${expected}, got Map`),
    [CborKinds.Tag]: (v: CborValue) => invalid(v, `${expected}, got Tag`),
    [CborKinds.Simple]: (v: CborValue) => invalid(v, `${expected}, got Simple`),
  }) as const;

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

const MetadatumRef = Schema.suspend((): Schema.Codec<Metadatum> => _Metadatum);

const _Metadatum = Schema.Union([
  Schema.TaggedStruct(MetadatumKind.Int, { value: Schema.BigInt }),
  Schema.TaggedStruct(MetadatumKind.Bytes, { value: Schema.Uint8Array }),
  Schema.TaggedStruct(MetadatumKind.Text, { value: Schema.String }),
  Schema.TaggedStruct(MetadatumKind.List, { items: Schema.Array(MetadatumRef) }),
  Schema.TaggedStruct(MetadatumKind.Map, {
    entries: Schema.Array(Schema.Tuple([MetadatumRef, MetadatumRef])),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

// Re-export without type annotation so .match()/.guards/.isAnyOf() stay accessible
export const Metadatum = _Metadatum;

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

// Array-branch: chunked Bytes, chunked Text, or genuine List of Metadatum.
// The byte-assembly loop in the chunked-Bytes case is procedural by design
// (plan §0.0c exemption for byte math).
function decodeMetadatumArray(
  items: ReadonlyArray<CborSchemaType>,
): Effect.Effect<Metadatum, SchemaIssue.Issue> {
  if (items.length > 0 && items.every(CborValueSchema.guards[CborKinds.Bytes])) {
    const totalLen = items.reduce((sum, i) => sum + i.bytes.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const item of items) {
      result.set(item.bytes, offset);
      offset += item.bytes.length;
    }
    return Effect.succeed({ _tag: MetadatumKind.Bytes as const, value: result });
  }
  if (items.length > 0 && items.every(CborValueSchema.guards[CborKinds.Text])) {
    const text = items.map((i) => i.text).join("");
    return Effect.succeed({ _tag: MetadatumKind.Text as const, value: text });
  }
  return Effect.all(items.map(decodeMetadatum)).pipe(
    Effect.map((decoded) => ({ _tag: MetadatumKind.List as const, items: decoded })),
  );
}

const decodeMetadatumMapEntry = (e: { k: CborSchemaType; v: CborSchemaType }) =>
  Effect.all([decodeMetadatum(e.k), decodeMetadatum(e.v)] as const);

export function decodeMetadatum(cbor: CborSchemaType): Effect.Effect<Metadatum, SchemaIssue.Issue> {
  return CborValueSchema.match({
    ...failOthers("Metadatum: unexpected CBOR kind"),
    [CborKinds.UInt]: (c): Effect.Effect<Metadatum, SchemaIssue.Issue> =>
      Effect.succeed({ _tag: MetadatumKind.Int as const, value: c.num }),
    [CborKinds.NegInt]: (c): Effect.Effect<Metadatum, SchemaIssue.Issue> =>
      Effect.succeed({ _tag: MetadatumKind.Int as const, value: c.num }),
    [CborKinds.Bytes]: (c): Effect.Effect<Metadatum, SchemaIssue.Issue> =>
      Effect.succeed({ _tag: MetadatumKind.Bytes as const, value: c.bytes }),
    [CborKinds.Text]: (c): Effect.Effect<Metadatum, SchemaIssue.Issue> =>
      Effect.succeed({ _tag: MetadatumKind.Text as const, value: c.text }),
    [CborKinds.Array]: (c): Effect.Effect<Metadatum, SchemaIssue.Issue> =>
      decodeMetadatumArray(c.items),
    [CborKinds.Map]: (c): Effect.Effect<Metadatum, SchemaIssue.Issue> =>
      Effect.all(c.entries.map(decodeMetadatumMapEntry)).pipe(
        Effect.map((entries) => ({ _tag: MetadatumKind.Map as const, entries })),
      ),
  })(cbor);
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
      return cborMap(
        m.entries.map(([k, v]) => ({
          k: encodeMetadatum(k),
          v: encodeMetadatum(v),
        })),
      );
  }
}

// ---------------------------------------------------------------------------
// TxMetadata CBOR encoder
// ---------------------------------------------------------------------------

export function encodeTxMetadata(meta: TxMetadata): CborSchemaType {
  return cborMap(
    meta.entries.map((e) => ({
      k: uint(e.label),
      v: encodeMetadatum(e.value),
    })),
  );
}

// ---------------------------------------------------------------------------
// AuxiliaryData CBOR encoder — always Alonzo+ format: Tag(259, Map{...})
// ---------------------------------------------------------------------------

function encodeScriptArray(scripts: ReadonlyArray<Uint8Array>): CborSchemaType {
  return arr(...scripts.map(cborBytes));
}

export function encodeAuxiliaryData(aux: AuxiliaryData): CborSchemaType {
  return cborTagged(
    259n,
    cborMap([
      ...mapEntry(0, aux.metadata ? encodeTxMetadata(aux.metadata) : undefined),
      ...mapEntry(1, aux.nativeScripts ? encodeScriptArray(aux.nativeScripts) : undefined),
      ...mapEntry(2, aux.plutusV1Scripts ? encodeScriptArray(aux.plutusV1Scripts) : undefined),
      ...mapEntry(3, aux.plutusV2Scripts ? encodeScriptArray(aux.plutusV2Scripts) : undefined),
      ...mapEntry(4, aux.plutusV3Scripts ? encodeScriptArray(aux.plutusV3Scripts) : undefined),
    ]),
  );
}

// ---------------------------------------------------------------------------
// TxMetadata CBOR decoder
// ---------------------------------------------------------------------------

const decodeMetadataEntry = (e: { k: CborSchemaType; v: CborSchemaType }) =>
  Effect.all({
    label: expectUint(e.k, "TxMetadata.label"),
    value: decodeMetadatum(e.v),
  });

export function decodeTxMetadata(
  cbor: CborSchemaType,
): Effect.Effect<TxMetadata, SchemaIssue.Issue> {
  return expectMap(cbor, "TxMetadata").pipe(
    Effect.flatMap((mapEntries) => Effect.all(mapEntries.map(decodeMetadataEntry))),
    Effect.map((entries) => ({ entries })),
  );
}

// ---------------------------------------------------------------------------
// AuxiliaryData CBOR decoder
// ---------------------------------------------------------------------------

function extractScriptArray(
  cbor: CborSchemaType | undefined,
): ReadonlyArray<Uint8Array> | undefined {
  if (!cbor || !CborValueSchema.guards[CborKinds.Array](cbor)) return undefined;
  return cbor.items
    .filter(CborValueSchema.guards[CborKinds.Bytes])
    .map((i) => i.bytes);
}

// Alonzo+ aux-data: Tag(259, Map{0?: metadata, 1-4?: script arrays})
function decodeAlonzoAuxData(
  tagData: CborSchemaType,
): Effect.Effect<AuxiliaryData, SchemaIssue.Issue> {
  return expectMap(tagData, "AuxiliaryData(Alonzo+)").pipe(
    Effect.flatMap((mapEntries) => {
      const metaCbor = getMapValue(mapEntries, 0);
      const metadataEffect = metaCbor
        ? decodeTxMetadata(metaCbor).pipe(Effect.map(Option.some))
        : Effect.succeed(Option.none<TxMetadata>());
      return metadataEffect.pipe(
        Effect.map((metadataOpt) => ({
          metadata: Option.getOrUndefined(metadataOpt),
          nativeScripts: extractScriptArray(getMapValue(mapEntries, 1)),
          plutusV1Scripts: extractScriptArray(getMapValue(mapEntries, 2)),
          plutusV2Scripts: extractScriptArray(getMapValue(mapEntries, 3)),
          plutusV3Scripts: extractScriptArray(getMapValue(mapEntries, 4)),
        })),
      );
    }),
  );
}

export function decodeAuxiliaryData(
  cbor: CborSchemaType,
): Effect.Effect<AuxiliaryData, SchemaIssue.Issue> {
  return CborValueSchema.match({
    ...failOthers("AuxiliaryData: expected Tag(259, Map), Map, or Array"),
    // Alonzo+: Tag(259, Map{...})
    [CborKinds.Tag]: (c): Effect.Effect<AuxiliaryData, SchemaIssue.Issue> =>
      c.tag === 259n
        ? decodeAlonzoAuxData(c.data)
        : invalid(c, `AuxiliaryData: expected Tag 259, got Tag ${c.tag}`),
    // Shelley: bare metadata map
    [CborKinds.Map]: (c): Effect.Effect<AuxiliaryData, SchemaIssue.Issue> =>
      decodeTxMetadata(c).pipe(
        Effect.map((metadata) => ({
          metadata,
          nativeScripts: undefined,
          plutusV1Scripts: undefined,
          plutusV2Scripts: undefined,
          plutusV3Scripts: undefined,
        })),
      ),
    // Shelley/Allegra: [metadata, nativeScripts]
    [CborKinds.Array]: (c): Effect.Effect<AuxiliaryData, SchemaIssue.Issue> =>
      c.items.length === 2
        ? decodeTxMetadata(c.items[0]!).pipe(
            Effect.map((metadata) => ({
              metadata,
              nativeScripts: extractScriptArray(c.items[1]),
              plutusV1Scripts: undefined,
              plutusV2Scripts: undefined,
              plutusV3Scripts: undefined,
            })),
          )
        : invalid(c, "AuxiliaryData: expected 2-element array"),
  })(cbor);
}
