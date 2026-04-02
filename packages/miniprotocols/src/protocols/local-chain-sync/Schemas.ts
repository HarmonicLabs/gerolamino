import { Schema, SchemaGetter } from "effect";

import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema";
import { ChainPointSchema, ChainPointType, type ChainPoint } from "../types/ChainPoint";
import { ChainTipSchema, type ChainTip } from "../types/ChainTip";

// LocalChainSync has the same state machine as ChainSync but uses
// mini-protocol ID #5 and transports full blocks instead of headers.

export enum LocalChainSyncMessageType {
  RequestNext = "RequestNext",
  AwaitReply = "AwaitReply",
  RollForward = "RollForward",
  RollBackward = "RollBackward",
  FindIntersect = "FindIntersect",
  IntersectFound = "IntersectFound",
  IntersectNotFound = "IntersectNotFound",
  Done = "Done",
}

export const LocalChainSyncMessageTypeSchema = Schema.Enum(LocalChainSyncMessageType);

export const LocalChainSyncMessage = Schema.Union([
  Schema.TaggedStruct(LocalChainSyncMessageType.RequestNext, {}),
  Schema.TaggedStruct(LocalChainSyncMessageType.AwaitReply, {}),
  Schema.TaggedStruct(LocalChainSyncMessageType.RollForward, {
    block: Schema.Uint8Array,
    tip: ChainTipSchema,
  }),
  Schema.TaggedStruct(LocalChainSyncMessageType.RollBackward, {
    point: ChainPointSchema,
    tip: ChainTipSchema,
  }),
  Schema.TaggedStruct(LocalChainSyncMessageType.FindIntersect, {
    points: Schema.Array(ChainPointSchema),
  }),
  Schema.TaggedStruct(LocalChainSyncMessageType.IntersectFound, {
    point: ChainPointSchema,
    tip: ChainTipSchema,
  }),
  Schema.TaggedStruct(LocalChainSyncMessageType.IntersectNotFound, {
    tip: ChainTipSchema,
  }),
  Schema.TaggedStruct(LocalChainSyncMessageType.Done, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type LocalChainSyncMessageT = Schema.Schema.Type<typeof LocalChainSyncMessage>;

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
    items: [
      encodeChainPoint(tip.point),
      { _tag: CborKinds.UInt, num: BigInt(tip.blockNo) },
    ],
  };
}

// ── CBOR wire format (same as ChainSync but with full blocks) ──

export const LocalChainSyncMessageBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(LocalChainSyncMessage, {
    decode: SchemaGetter.transform((cbor: CborSchemaType) => {
      if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
      const tag = cbor.items[0];
      if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
      switch (Number(tag.num)) {
        case 0:
          return { _tag: LocalChainSyncMessageType.RequestNext as const };
        case 1:
          return { _tag: LocalChainSyncMessageType.AwaitReply as const };
        case 2: {
          const block = cbor.items[1];
          if (block?._tag !== CborKinds.Bytes) throw new Error("Expected bytes for block");
          return {
            _tag: LocalChainSyncMessageType.RollForward as const,
            block: block.bytes,
            tip: decodeChainTip(cbor.items[2]!),
          };
        }
        case 3:
          return {
            _tag: LocalChainSyncMessageType.RollBackward as const,
            point: decodeChainPoint(cbor.items[1]!),
            tip: decodeChainTip(cbor.items[2]!),
          };
        case 4: {
          const arr = cbor.items[1];
          if (arr?._tag !== CborKinds.Array) throw new Error("Expected CBOR array for points");
          return {
            _tag: LocalChainSyncMessageType.FindIntersect as const,
            points: arr.items.map(decodeChainPoint),
          };
        }
        case 5:
          return {
            _tag: LocalChainSyncMessageType.IntersectFound as const,
            point: decodeChainPoint(cbor.items[1]!),
            tip: decodeChainTip(cbor.items[2]!),
          };
        case 6:
          return {
            _tag: LocalChainSyncMessageType.IntersectNotFound as const,
            tip: decodeChainTip(cbor.items[1]!),
          };
        case 7:
          return { _tag: LocalChainSyncMessageType.Done as const };
        default:
          throw new Error(`Unknown LocalChainSync tag: ${Number(tag.num)}`);
      }
    }),
    encode: SchemaGetter.transform(
      LocalChainSyncMessage.match({
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
            { _tag: CborKinds.Bytes, bytes: m.block },
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
          items: [
            { _tag: CborKinds.UInt, num: 6n },
            encodeChainTip(m.tip),
          ],
        }),
        Done: (): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 7n }],
        }),
      }),
    ),
  }),
);
