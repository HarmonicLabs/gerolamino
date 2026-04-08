import { MultiplexerProtocolTypeSchema } from "../../multiplexer";
import { Equivalence, Schema, SchemaGetter } from "effect";

import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema";

// Base types
export const VersionNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
export const NetworkMagic = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
export const Query = Schema.Boolean;
export const InitiatorOnlyDiffusionMode = Schema.Boolean;
// peerSharing is 0 | 1 | 2 per CDDL spec (not a boolean)
export const PeerSharing = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(2),
);

// Node-to-node version data (application type)
export const NodeToNodeVersionDataSchema = Schema.Struct({
  networkMagic: NetworkMagic,
  initiatorOnlyDiffusionMode: InitiatorOnlyDiffusionMode,
  peerSharing: PeerSharing,
  query: Query,
});

// Node-to-client version data (application type)
export const NodeToClientVersionDataSchema = Schema.Struct({
  networkMagic: NetworkMagic,
  query: Query,
});

export const VersionTableSchema = Schema.Union([
  Schema.TaggedStruct(MultiplexerProtocolTypeSchema.enums.NodeToNode, {
    data: Schema.Record(VersionNumber, NodeToNodeVersionDataSchema),
  }),
  Schema.TaggedStruct(MultiplexerProtocolTypeSchema.enums.NodeToClient, {
    data: Schema.Record(VersionNumber, NodeToClientVersionDataSchema),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export enum RefuseReasonType {
  VersionMismatch,
  HandshakeDecodeError,
  Refused,
}

export const RefuseReasonTypeSchema = Schema.Enum(RefuseReasonType);

export const RefuseReasonSchema = Schema.Union([
  Schema.TaggedStruct(RefuseReasonType.VersionMismatch, {
    validVersions: Schema.Array(VersionNumber),
  }),
  Schema.TaggedStruct(RefuseReasonType.HandshakeDecodeError, {
    version: VersionNumber,
    message: Schema.String,
  }),
  Schema.TaggedStruct(RefuseReasonType.Refused, {
    version: VersionNumber,
    message: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export enum HandshakeMessageType {
  MsgProposeVersions,
  MsgAcceptVersion,
  MsgRefuse,
  MsgQueryReply,
}

export const HandshakeMessageTypeSchema = Schema.Enum(HandshakeMessageType);

// Tagged union versions (for application logic)
export const HandshakeMessage = Schema.Union([
  Schema.TaggedStruct(HandshakeMessageType.MsgProposeVersions, {
    versionTable: VersionTableSchema,
  }),
  Schema.TaggedStruct(HandshakeMessageType.MsgAcceptVersion, {
    version: VersionNumber,
    versionData: Schema.Union([NodeToNodeVersionDataSchema, NodeToClientVersionDataSchema]),
  }),
  Schema.TaggedStruct(HandshakeMessageType.MsgRefuse, {
    reason: RefuseReasonSchema,
  }),
  Schema.TaggedStruct(HandshakeMessageType.MsgQueryReply, {
    versionTable: VersionTableSchema.check(
      Schema.makeFilter(({ _tag }) =>
        Equivalence.String(_tag, MultiplexerProtocolTypeSchema.enums.NodeToClient),
      ),
    ),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

// ── CBOR ↔ Application conversion helpers ──

// VersionTable: application { _tag, data: { ver: structFields } } ↔ CBOR Map { ver: [fields...] }
const versionTableToCbor = (vt: VersionTable): CborSchemaType => ({
  _tag: CborKinds.Map,
  entries: Object.entries(vt.data).map(([ver, vData]) => ({
    k: { _tag: CborKinds.UInt, num: BigInt(parseInt(ver, 10)) } as CborSchemaType,
    v:
      vt._tag === MultiplexerProtocolTypeSchema.enums.NodeToNode
        ? ({
            _tag: CborKinds.Array,
            items: [
              { _tag: CborKinds.UInt, num: BigInt((vData as NodeToNodeVersionData).networkMagic) },
              {
                _tag: CborKinds.Simple,
                value: (vData as NodeToNodeVersionData).initiatorOnlyDiffusionMode,
              },
              { _tag: CborKinds.UInt, num: BigInt((vData as NodeToNodeVersionData).peerSharing) },
              { _tag: CborKinds.Simple, value: (vData as NodeToNodeVersionData).query },
            ],
          } as CborSchemaType)
        : ({
            _tag: CborKinds.Array,
            items: [
              {
                _tag: CborKinds.UInt,
                num: BigInt((vData as NodeToClientVersionData).networkMagic),
              },
              { _tag: CborKinds.Simple, value: (vData as NodeToClientVersionData).query },
            ],
          } as CborSchemaType),
  })),
});

// CBOR Map { ver: [fields...] } → application { _tag, data: { ver: structFields } }
const versionTableFromCbor = (mapNode: CborSchemaType): VersionTable => {
  if (mapNode._tag !== CborKinds.Map) throw new Error("Expected CBOR map for versionTable");
  const entries = mapNode.entries;
  if (entries.length === 0) {
    return {
      _tag: MultiplexerProtocolTypeSchema.enums.NodeToNode,
      data: {},
    };
  }
  // Detect N2N vs N2C by first entry's array length
  const firstVal = entries[0]!.v as Extract<CborSchemaType, { _tag: CborKinds.Array }>;
  const isN2N = firstVal.items.length === 4;
  const data: Record<number, NodeToNodeVersionData | NodeToClientVersionData> = {};
  for (const entry of entries) {
    const ver = Number((entry.k as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num);
    const arr = entry.v as Extract<CborSchemaType, { _tag: CborKinds.Array }>;
    data[ver] = isN2N
      ? {
          networkMagic: Number(
            (arr.items[0] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num,
          ),
          initiatorOnlyDiffusionMode: (
            arr.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Simple }>
          ).value as boolean,
          peerSharing: Number(
            (arr.items[2] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num,
          ),
          query: (arr.items[3] as Extract<CborSchemaType, { _tag: CborKinds.Simple }>)
            .value as boolean,
        }
      : {
          networkMagic: Number(
            (arr.items[0] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num,
          ),
          query: (arr.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Simple }>)
            .value as boolean,
        };
  }
  return isN2N
    ? { _tag: MultiplexerProtocolTypeSchema.enums.NodeToNode, data }
    : { _tag: MultiplexerProtocolTypeSchema.enums.NodeToClient, data };
};

// VersionData: application struct ↔ CBOR array [fields...]
const versionDataToCbor = (vd: NodeToNodeVersionData | NodeToClientVersionData): CborSchemaType =>
  "peerSharing" in vd
    ? ({
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: BigInt(vd.networkMagic) },
          { _tag: CborKinds.Simple, value: vd.initiatorOnlyDiffusionMode },
          { _tag: CborKinds.UInt, num: BigInt(vd.peerSharing) },
          { _tag: CborKinds.Simple, value: vd.query },
        ],
      } as CborSchemaType)
    : ({
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: BigInt(vd.networkMagic) },
          { _tag: CborKinds.Simple, value: vd.query },
        ],
      } as CborSchemaType);

const versionDataFromCbor = (
  node: CborSchemaType,
): NodeToNodeVersionData | NodeToClientVersionData => {
  const arr = node as Extract<CborSchemaType, { _tag: CborKinds.Array }>;
  return arr.items.length === 4
    ? {
        networkMagic: Number(
          (arr.items[0] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num,
        ),
        initiatorOnlyDiffusionMode: (
          arr.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Simple }>
        ).value as boolean,
        peerSharing: Number(
          (arr.items[2] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num,
        ),
        query: (arr.items[3] as Extract<CborSchemaType, { _tag: CborKinds.Simple }>)
          .value as boolean,
      }
    : {
        networkMagic: Number(
          (arr.items[0] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num,
        ),
        query: (arr.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Simple }>)
          .value as boolean,
      };
};

// RefuseReason: CBOR array [tag, ...data] → application tagged struct
const refuseReasonFromCbor = (node: CborSchemaType): RefuseReason => {
  const arr = node as Extract<CborSchemaType, { _tag: CborKinds.Array }>;
  const reasonTag = Number((arr.items[0] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num);
  if (reasonTag === 0) {
    const versArray = arr.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Array }>;
    return {
      _tag: RefuseReasonType.VersionMismatch as const,
      validVersions: versArray.items.map((v) =>
        Number((v as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num),
      ),
    };
  } else if (reasonTag === 1) {
    return {
      _tag: RefuseReasonType.HandshakeDecodeError as const,
      version: Number((arr.items[1] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num),
      message: (arr.items[2] as Extract<CborSchemaType, { _tag: CborKinds.Text }>).text,
    };
  } else {
    return {
      _tag: RefuseReasonType.Refused as const,
      version: Number((arr.items[1] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num),
      message: (arr.items[2] as Extract<CborSchemaType, { _tag: CborKinds.Text }>).text,
    };
  }
};

const refuseReasonToCbor = (reason: RefuseReason): CborSchemaType =>
  reason._tag === RefuseReasonType.VersionMismatch
    ? ({
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: BigInt(reason._tag) },
          {
            _tag: CborKinds.Array,
            items: reason.validVersions.map(
              (v): CborSchemaType => ({ _tag: CborKinds.UInt, num: BigInt(v) }),
            ),
          },
        ],
      } as CborSchemaType)
    : ({
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: BigInt(reason._tag) },
          { _tag: CborKinds.UInt, num: BigInt(reason.version) },
          { _tag: CborKinds.Text, text: reason.message },
        ],
      } as CborSchemaType);

// Full Uint8Array ↔ HandshakeMessage schema via CBOR
export const HandshakeMessageBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(HandshakeMessage, {
    decode: SchemaGetter.transform((cbor: CborSchemaType) => {
      if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
      const tag = cbor.items[0];
      if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
      switch (Number(tag.num)) {
        case 0:
          return {
            _tag: HandshakeMessageType.MsgProposeVersions as const,
            versionTable: versionTableFromCbor(cbor.items[1]!),
          };
        case 1:
          return {
            _tag: HandshakeMessageType.MsgAcceptVersion as const,
            version: Number(
              (cbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num,
            ),
            versionData: versionDataFromCbor(cbor.items[2]!),
          };
        case 2:
          return {
            _tag: HandshakeMessageType.MsgRefuse as const,
            reason: refuseReasonFromCbor(cbor.items[1]!),
          };
        default:
          return {
            _tag: HandshakeMessageType.MsgQueryReply as const,
            versionTable: versionTableFromCbor(cbor.items[1]!),
          };
      }
    }),
    encode: SchemaGetter.transform((data): CborSchemaType => {
      switch (data._tag) {
        case HandshakeMessageType.MsgProposeVersions:
          return {
            _tag: CborKinds.Array,
            items: [{ _tag: CborKinds.UInt, num: 0n }, versionTableToCbor(data.versionTable)],
          };
        case HandshakeMessageType.MsgAcceptVersion:
          return {
            _tag: CborKinds.Array,
            items: [
              { _tag: CborKinds.UInt, num: 1n },
              { _tag: CborKinds.UInt, num: BigInt(data.version) },
              versionDataToCbor(data.versionData),
            ],
          };
        case HandshakeMessageType.MsgRefuse:
          return {
            _tag: CborKinds.Array,
            items: [{ _tag: CborKinds.UInt, num: 2n }, refuseReasonToCbor(data.reason)],
          };
        case HandshakeMessageType.MsgQueryReply:
          return {
            _tag: CborKinds.Array,
            items: [{ _tag: CborKinds.UInt, num: 3n }, versionTableToCbor(data.versionTable)],
          };
      }
    }),
  }),
);

// ── Derived type aliases for consumers ──

export type NodeToNodeVersionData = Schema.Schema.Type<typeof NodeToNodeVersionDataSchema>;
export type NodeToClientVersionData = Schema.Schema.Type<typeof NodeToClientVersionDataSchema>;
export type VersionTable = Schema.Schema.Type<typeof VersionTableSchema>;
export type RefuseReason = Schema.Schema.Type<typeof RefuseReasonSchema>;
export type HandshakeMessageT = Schema.Schema.Type<typeof HandshakeMessage>;
