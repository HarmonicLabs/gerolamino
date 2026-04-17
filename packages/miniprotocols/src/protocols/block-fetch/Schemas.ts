import { Schema } from "effect";

import { cborSyncCodec, CborKinds, type CborSchemaType, encodeSync } from "codecs";
import { ChainPointSchema, ChainPointType, type ChainPoint } from "../types/ChainPoint";

// ── Application-level types ──

export enum BlockFetchMessageType {
  RequestRange = "RequestRange",
  ClientDone = "ClientDone",
  StartBatch = "StartBatch",
  NoBlocks = "NoBlocks",
  Block = "Block",
  BatchDone = "BatchDone",
}

export const BlockFetchMessageTypeSchema = Schema.Enum(BlockFetchMessageType);

export const BlockFetchMessage = Schema.Union([
  Schema.TaggedStruct(BlockFetchMessageType.RequestRange, {
    from: ChainPointSchema,
    to: ChainPointSchema,
  }),
  Schema.TaggedStruct(BlockFetchMessageType.ClientDone, {}),
  Schema.TaggedStruct(BlockFetchMessageType.StartBatch, {}),
  Schema.TaggedStruct(BlockFetchMessageType.NoBlocks, {}),
  Schema.TaggedStruct(BlockFetchMessageType.Block, {
    block: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(BlockFetchMessageType.BatchDone, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type BlockFetchMessageT = typeof BlockFetchMessage.Type;

// ── CBOR helpers for ChainPoint ──

function decodeChainPoint(node: CborSchemaType): ChainPoint {
  if (node._tag !== CborKinds.Array) throw new Error("Expected CBOR array for ChainPoint");
  if (node.items.length === 0) return { _tag: ChainPointType.Origin as const };
  const slot = node.items[0];
  const hash = node.items[1];
  if (slot?._tag !== CborKinds.UInt) throw new Error("Expected uint for slot");
  if (hash?._tag !== CborKinds.Bytes) throw new Error("Expected bytes for hash");
  return { _tag: ChainPointType.RealPoint as const, slot: Number(slot.num), hash: hash.bytes };
}

const encodeChainPoint = ChainPointSchema.match({
  Origin: (): CborSchemaType => ({ _tag: CborKinds.Array, items: [] }),
  RealPoint: (p): CborSchemaType => ({
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: BigInt(p.slot) },
      { _tag: CborKinds.Bytes, bytes: p.hash },
    ],
  }),
});

// ── CBOR wire format ──
// [0, from, to] — RequestRange
// [1]           — ClientDone
// [2]           — StartBatch
// [3]           — NoBlocks
// [4, block]    — Block
// [5]           — BatchDone

export const BlockFetchMessageBytes = cborSyncCodec(
  BlockFetchMessage,
  (cbor) => {
    if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
    const tag = cbor.items[0];
    if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
    switch (Number(tag.num)) {
      case 0:
        return {
          _tag: BlockFetchMessageType.RequestRange as const,
          from: decodeChainPoint(cbor.items[1]!),
          to: decodeChainPoint(cbor.items[2]!),
        };
      case 1:
        return { _tag: BlockFetchMessageType.ClientDone as const };
      case 2:
        return { _tag: BlockFetchMessageType.StartBatch as const };
      case 3:
        return { _tag: BlockFetchMessageType.NoBlocks as const };
      case 4: {
        const blockCbor = cbor.items[1];
        // Block can be bare Bytes or Tag(24, Bytes) (CBOR-in-CBOR wrapping in N2N)
        let blockBytes: Uint8Array;
        if (blockCbor?._tag === CborKinds.Bytes) {
          blockBytes = blockCbor.bytes;
        } else if (
          blockCbor?._tag === CborKinds.Tag &&
          blockCbor.tag === 24n &&
          blockCbor.data._tag === CborKinds.Bytes
        ) {
          blockBytes = blockCbor.data.bytes;
        } else {
          blockBytes = encodeSync(blockCbor!);
        }
        return { _tag: BlockFetchMessageType.Block as const, block: blockBytes };
      }
      case 5:
        return { _tag: BlockFetchMessageType.BatchDone as const };
      default:
        throw new Error(`Unknown BlockFetch tag: ${Number(tag.num)}`);
    }
  },
  BlockFetchMessage.match({
    RequestRange: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 0n },
        encodeChainPoint(m.from),
        encodeChainPoint(m.to),
      ],
    }),
    ClientDone: (): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 1n }],
    }),
    StartBatch: (): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 2n }],
    }),
    NoBlocks: (): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 3n }],
    }),
    Block: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 4n },
        { _tag: CborKinds.Bytes, bytes: m.block },
      ],
    }),
    BatchDone: (): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 5n }],
    }),
  }),
);
