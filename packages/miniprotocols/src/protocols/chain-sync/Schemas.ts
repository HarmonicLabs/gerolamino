import { Schema, SchemaGetter } from "effect";

import { CborSchemaFromBytes, CborKinds, type CborSchemaType, encodeSync } from "cbor-schema";
import { ChainPointSchema, ChainPointType, type ChainPoint } from "../types/ChainPoint";
import { ChainTipSchema, type ChainTip } from "../types/ChainTip";

// ── Application-level types ──

export enum ChainSyncMessageType {
  RequestNext = "RequestNext",
  AwaitReply = "AwaitReply",
  RollForward = "RollForward",
  RollBackward = "RollBackward",
  FindIntersect = "FindIntersect",
  IntersectFound = "IntersectFound",
  IntersectNotFound = "IntersectNotFound",
  Done = "Done",
}

export const ChainSyncMessageTypeSchema = Schema.Enum(ChainSyncMessageType);

export const ChainSyncMessage = Schema.Union([
  Schema.TaggedStruct(ChainSyncMessageType.RequestNext, {}),
  Schema.TaggedStruct(ChainSyncMessageType.AwaitReply, {}),
  Schema.TaggedStruct(ChainSyncMessageType.RollForward, {
    header: Schema.Uint8Array,
    tip: ChainTipSchema,
  }),
  Schema.TaggedStruct(ChainSyncMessageType.RollBackward, {
    point: ChainPointSchema,
    tip: ChainTipSchema,
  }),
  Schema.TaggedStruct(ChainSyncMessageType.FindIntersect, {
    points: Schema.Array(ChainPointSchema),
  }),
  Schema.TaggedStruct(ChainSyncMessageType.IntersectFound, {
    point: ChainPointSchema,
    tip: ChainTipSchema,
  }),
  Schema.TaggedStruct(ChainSyncMessageType.IntersectNotFound, {
    tip: ChainTipSchema,
  }),
  Schema.TaggedStruct(ChainSyncMessageType.Done, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type ChainSyncMessageT = Schema.Schema.Type<typeof ChainSyncMessage>;

// ── CBOR helpers for ChainPoint / ChainTip ──

function decodeChainPoint(node: CborSchemaType): ChainPoint {
  if (node._tag !== CborKinds.Array) throw new Error("Expected CBOR array for ChainPoint");
  if (node.items.length === 0) return { _tag: ChainPointType.Origin as const };
  const slot = node.items[0];
  const hash = node.items[1];
  if (slot?._tag !== CborKinds.UInt) throw new Error("Expected uint for slot");
  if (hash?._tag !== CborKinds.Bytes) throw new Error("Expected bytes for hash");
  return { _tag: ChainPointType.RealPoint as const, slot: Number(slot.num), hash: hash.bytes };
}

function encodeChainPoint(point: ChainPoint): CborSchemaType {
  if (point._tag === ChainPointType.Origin) return { _tag: CborKinds.Array, items: [] };
  return {
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: BigInt(point.slot) },
      { _tag: CborKinds.Bytes, bytes: point.hash },
    ],
  };
}

function decodeChainTip(node: CborSchemaType): ChainTip {
  if (node._tag !== CborKinds.Array) throw new Error("Expected CBOR array for ChainTip");
  const blockNo = node.items[1];
  if (blockNo?._tag !== CborKinds.UInt) throw new Error("Expected uint for blockNo");
  return { point: decodeChainPoint(node.items[0]!), blockNo: Number(blockNo.num) };
}

function encodeChainTip(tip: ChainTip): CborSchemaType {
  return {
    _tag: CborKinds.Array,
    items: [encodeChainPoint(tip.point), { _tag: CborKinds.UInt, num: BigInt(tip.blockNo) }],
  };
}

// ── CBOR wire format ──
// [0]                — RequestNext
// [1]                — AwaitReply
// [2, header, tip]   — RollForward
// [3, point, tip]    — RollBackward
// [4, [point*]]      — FindIntersect
// [5, point, tip]    — IntersectFound
// [6, tip]           — IntersectNotFound
// [7]                — Done

export const ChainSyncMessageBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(ChainSyncMessage, {
    decode: SchemaGetter.transform((cbor: CborSchemaType) => {
      if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
      const tag = cbor.items[0];
      if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
      switch (Number(tag.num)) {
        case 0:
          return { _tag: ChainSyncMessageType.RequestNext as const };
        case 1:
          return { _tag: ChainSyncMessageType.AwaitReply as const };
        case 2: {
          const headerCbor = cbor.items[1];
          // Header can be bare Bytes or Tag(24, Bytes) (CBOR-in-CBOR wrapping used in N2N)
          let headerBytes: Uint8Array;
          if (headerCbor?._tag === CborKinds.Bytes) {
            headerBytes = headerCbor.bytes;
          } else if (
            headerCbor?._tag === CborKinds.Tag &&
            headerCbor.tag === 24n &&
            headerCbor.data._tag === CborKinds.Bytes
          ) {
            headerBytes = headerCbor.data.bytes;
          } else {
            // Fallback: encode whatever CBOR we got as bytes
            headerBytes = encodeSync(headerCbor!);
          }
          return {
            _tag: ChainSyncMessageType.RollForward as const,
            header: headerBytes,
            tip: decodeChainTip(cbor.items[2]!),
          };
        }
        case 3:
          return {
            _tag: ChainSyncMessageType.RollBackward as const,
            point: decodeChainPoint(cbor.items[1]!),
            tip: decodeChainTip(cbor.items[2]!),
          };
        case 4: {
          const arr = cbor.items[1];
          if (arr?._tag !== CborKinds.Array) throw new Error("Expected CBOR array for points");
          return {
            _tag: ChainSyncMessageType.FindIntersect as const,
            points: arr.items.map(decodeChainPoint),
          };
        }
        case 5:
          return {
            _tag: ChainSyncMessageType.IntersectFound as const,
            point: decodeChainPoint(cbor.items[1]!),
            tip: decodeChainTip(cbor.items[2]!),
          };
        case 6:
          return {
            _tag: ChainSyncMessageType.IntersectNotFound as const,
            tip: decodeChainTip(cbor.items[1]!),
          };
        case 7:
          return { _tag: ChainSyncMessageType.Done as const };
        default:
          throw new Error(`Unknown ChainSync tag: ${Number(tag.num)}`);
      }
    }),
    encode: SchemaGetter.transform(
      ChainSyncMessage.match({
        RequestNext: (): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 0n }],
        }),
        AwaitReply: (): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 1n }],
        }),
        RollForward: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 2n },
            { _tag: CborKinds.Bytes, bytes: m.header },
            encodeChainTip(m.tip),
          ],
        }),
        RollBackward: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 3n },
            encodeChainPoint(m.point),
            encodeChainTip(m.tip),
          ],
        }),
        FindIntersect: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 4n },
            { _tag: CborKinds.Array, items: m.points.map(encodeChainPoint) },
          ],
        }),
        IntersectFound: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 5n },
            encodeChainPoint(m.point),
            encodeChainTip(m.tip),
          ],
        }),
        IntersectNotFound: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 6n }, encodeChainTip(m.tip)],
        }),
        Done: (): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 7n }],
        }),
      }),
    ),
  }),
);
