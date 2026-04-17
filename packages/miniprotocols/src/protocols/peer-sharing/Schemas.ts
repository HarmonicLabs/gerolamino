import { Schema } from "effect";

import {
  cborSyncCodec,
  CborKinds,
  type CborSchemaType,
  cborUint,
  cborBytes,
  cborArray,
} from "codecs";

// ── PeerAddress types ──
// IPv4 = [0, bytes4, port]
// IPv6 = [1, bytes16, port]

export enum PeerAddressType {
  IPv4 = "IPv4",
  IPv6 = "IPv6",
}

export const PeerAddressSchema = Schema.Union([
  Schema.TaggedStruct(PeerAddressType.IPv4, {
    addr: Schema.Uint8Array,
    port: Schema.Number,
  }),
  Schema.TaggedStruct(PeerAddressType.IPv6, {
    addr: Schema.Uint8Array,
    port: Schema.Number,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type PeerAddress = typeof PeerAddressSchema.Type;

// ── PeerAddress CBOR helpers ──

const decodePeerAddress = (node: CborSchemaType): PeerAddress => {
  if (node._tag !== CborKinds.Array) throw new Error("Expected CBOR array for PeerAddress");
  const tagNode = node.items[0];
  if (tagNode?._tag !== CborKinds.UInt) throw new Error("Expected uint tag for PeerAddress");
  const addrBytesVal = cborBytes(node.items[1]!, "PeerAddress addr");
  const port = Number(cborUint(node.items[2]!, "PeerAddress port"));
  return Number(tagNode.num) === 0
    ? { _tag: PeerAddressType.IPv4 as const, addr: addrBytesVal, port }
    : { _tag: PeerAddressType.IPv6 as const, addr: addrBytesVal, port };
};

const encodePeerAddress = PeerAddressSchema.match({
  IPv4: (pa): CborSchemaType => ({
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: 0n },
      { _tag: CborKinds.Bytes, bytes: pa.addr },
      { _tag: CborKinds.UInt, num: BigInt(pa.port) },
    ],
  }),
  IPv6: (pa): CborSchemaType => ({
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: 1n },
      { _tag: CborKinds.Bytes, bytes: pa.addr },
      { _tag: CborKinds.UInt, num: BigInt(pa.port) },
    ],
  }),
});

// ── PeerSharing messages ──

export enum PeerSharingMessageType {
  ShareRequest = "ShareRequest",
  SharePeers = "SharePeers",
  Done = "Done",
}

export const PeerSharingMessageTypeSchema = Schema.Enum(PeerSharingMessageType);

export const PeerSharingMessage = Schema.Union([
  Schema.TaggedStruct(PeerSharingMessageType.ShareRequest, {
    amount: Schema.Number,
  }),
  Schema.TaggedStruct(PeerSharingMessageType.SharePeers, {
    peers: Schema.Array(PeerAddressSchema),
  }),
  Schema.TaggedStruct(PeerSharingMessageType.Done, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type PeerSharingMessageT = typeof PeerSharingMessage.Type;

// ── CBOR wire format ──
// [0, amount]           — ShareRequest
// [1, [peerAddress*]]   — SharePeers
// [2]                   — Done

export const PeerSharingMessageBytes = cborSyncCodec(
  PeerSharingMessage,
  (cbor) => {
    if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
    const tag = cbor.items[0];
    if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
    switch (Number(tag.num)) {
      case 0:
        return {
          _tag: PeerSharingMessageType.ShareRequest as const,
          amount: Number(cborUint(cbor.items[1]!, "ShareRequest amount")),
        };
      case 1: {
        const peersItems = cborArray(cbor.items[1]!, "SharePeers peers");
        return {
          _tag: PeerSharingMessageType.SharePeers as const,
          peers: peersItems.map(decodePeerAddress),
        };
      }
      default:
        return { _tag: PeerSharingMessageType.Done as const };
    }
  },
  PeerSharingMessage.match({
    ShareRequest: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 0n },
        { _tag: CborKinds.UInt, num: BigInt(m.amount) },
      ],
    }),
    SharePeers: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 1n },
        { _tag: CborKinds.Array, items: m.peers.map(encodePeerAddress) },
      ],
    }),
    Done: (): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 2n }],
    }),
  }),
);
