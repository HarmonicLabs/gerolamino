import { MultiplexerProtocolTypeSchema } from "../../multiplexer";
import { Equivalence, Schema, SchemaGetter } from "effect";

import {
  CborSchemaFromBytes,
  CborKinds,
  type CborSchemaType,
  cborUint,
  cborArray,
  cborBool,
  cborText,
} from "cbor-schema";

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
/** Type guard for NodeToNodeVersionData (has peerSharing field). */
const isN2NVersionData = (
  vData: NodeToNodeVersionData | NodeToClientVersionData,
): vData is NodeToNodeVersionData => "peerSharing" in vData;

const versionTableToCbor = (vt: VersionTable): CborSchemaType => ({
  _tag: CborKinds.Map,
  entries: Object.entries(vt.data).map(
    ([ver, vData]): { k: CborSchemaType; v: CborSchemaType } => ({
      k: { _tag: CborKinds.UInt, num: BigInt(parseInt(ver, 10)) },
      v: isN2NVersionData(vData)
        ? {
            _tag: CborKinds.Array,
            items: [
              { _tag: CborKinds.UInt, num: BigInt(vData.networkMagic) },
              { _tag: CborKinds.Simple, value: vData.initiatorOnlyDiffusionMode },
              { _tag: CborKinds.UInt, num: BigInt(vData.peerSharing) },
              { _tag: CborKinds.Simple, value: vData.query },
            ],
          }
        : {
            _tag: CborKinds.Array,
            items: [
              { _tag: CborKinds.UInt, num: BigInt(vData.networkMagic) },
              { _tag: CborKinds.Simple, value: vData.query },
            ],
          },
    }),
  ),
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
  const firstValItems = cborArray(entries[0]!.v, "versionTable first value");
  const isN2N = firstValItems.length === 4;
  const data: Record<number, NodeToNodeVersionData | NodeToClientVersionData> = {};
  for (const entry of entries) {
    const ver = Number(cborUint(entry.k, "versionTable key"));
    const arr = cborArray(entry.v, "versionTable value");
    data[ver] = isN2N
      ? {
          networkMagic: Number(cborUint(arr[0]!, "networkMagic")),
          initiatorOnlyDiffusionMode: cborBool(arr[1]!, "initiatorOnlyDiffusionMode"),
          peerSharing: Number(cborUint(arr[2]!, "peerSharing")),
          query: cborBool(arr[3]!, "query"),
        }
      : {
          networkMagic: Number(cborUint(arr[0]!, "networkMagic")),
          query: cborBool(arr[1]!, "query"),
        };
  }
  return isN2N
    ? { _tag: MultiplexerProtocolTypeSchema.enums.NodeToNode, data }
    : { _tag: MultiplexerProtocolTypeSchema.enums.NodeToClient, data };
};

// VersionData: application struct ↔ CBOR array [fields...]
const versionDataToCbor = (vd: NodeToNodeVersionData | NodeToClientVersionData): CborSchemaType =>
  "peerSharing" in vd
    ? {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: BigInt(vd.networkMagic) },
          { _tag: CborKinds.Simple, value: vd.initiatorOnlyDiffusionMode },
          { _tag: CborKinds.UInt, num: BigInt(vd.peerSharing) },
          { _tag: CborKinds.Simple, value: vd.query },
        ],
      }
    : {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: BigInt(vd.networkMagic) },
          { _tag: CborKinds.Simple, value: vd.query },
        ],
      };

const versionDataFromCbor = (
  node: CborSchemaType,
): NodeToNodeVersionData | NodeToClientVersionData => {
  const arr = cborArray(node, "versionData");
  return arr.length === 4
    ? {
        networkMagic: Number(cborUint(arr[0]!, "networkMagic")),
        initiatorOnlyDiffusionMode: cborBool(arr[1]!, "initiatorOnlyDiffusionMode"),
        peerSharing: Number(cborUint(arr[2]!, "peerSharing")),
        query: cborBool(arr[3]!, "query"),
      }
    : {
        networkMagic: Number(cborUint(arr[0]!, "networkMagic")),
        query: cborBool(arr[1]!, "query"),
      };
};

// RefuseReason: CBOR array [tag, ...data] → application tagged struct
const refuseReasonFromCbor = (node: CborSchemaType): RefuseReason => {
  const items = cborArray(node, "RefuseReason");
  const reasonTag = Number(cborUint(items[0]!, "RefuseReason tag"));
  if (reasonTag === 0) {
    const versItems = cborArray(items[1]!, "RefuseReason versions");
    return {
      _tag: RefuseReasonType.VersionMismatch as const,
      validVersions: versItems.map((v) => Number(cborUint(v, "version number"))),
    };
  } else if (reasonTag === 1) {
    return {
      _tag: RefuseReasonType.HandshakeDecodeError as const,
      version: Number(cborUint(items[1]!, "version")),
      message: cborText(items[2]!, "message"),
    };
  } else {
    return {
      _tag: RefuseReasonType.Refused as const,
      version: Number(cborUint(items[1]!, "version")),
      message: cborText(items[2]!, "message"),
    };
  }
};

const refuseReasonToCbor = RefuseReasonSchema.match({
  [RefuseReasonType.VersionMismatch]: (reason): CborSchemaType => ({
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
  }),
  [RefuseReasonType.HandshakeDecodeError]: (reason): CborSchemaType => ({
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: BigInt(reason._tag) },
      { _tag: CborKinds.UInt, num: BigInt(reason.version) },
      { _tag: CborKinds.Text, text: reason.message },
    ],
  }),
  [RefuseReasonType.Refused]: (reason): CborSchemaType => ({
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: BigInt(reason._tag) },
      { _tag: CborKinds.UInt, num: BigInt(reason.version) },
      { _tag: CborKinds.Text, text: reason.message },
    ],
  }),
});

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
            version: Number(cborUint(cbor.items[1]!, "MsgAcceptVersion version")),
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
    encode: SchemaGetter.transform(
      HandshakeMessage.match({
        [HandshakeMessageType.MsgProposeVersions]: (data): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 0n }, versionTableToCbor(data.versionTable)],
        }),
        [HandshakeMessageType.MsgAcceptVersion]: (data): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 1n },
            { _tag: CborKinds.UInt, num: BigInt(data.version) },
            versionDataToCbor(data.versionData),
          ],
        }),
        [HandshakeMessageType.MsgRefuse]: (data): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 2n }, refuseReasonToCbor(data.reason)],
        }),
        [HandshakeMessageType.MsgQueryReply]: (data): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 3n }, versionTableToCbor(data.versionTable)],
        }),
      }),
    ),
  }),
);

// ── Derived type aliases for consumers ──

export type NodeToNodeVersionData = typeof NodeToNodeVersionDataSchema.Type;
export type NodeToClientVersionData = typeof NodeToClientVersionDataSchema.Type;
export type VersionTable = typeof VersionTableSchema.Type;
export type RefuseReason = typeof RefuseReasonSchema.Type;
export type HandshakeMessageT = typeof HandshakeMessage.Type;
