import { Schema, SchemaGetter } from "effect";

import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema";
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

export type BlockFetchMessageT = Schema.Schema.Type<typeof BlockFetchMessage>;

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

// ── CBOR wire format ──
// [0, from, to] — RequestRange
// [1]           — ClientDone
// [2]           — StartBatch
// [3]           — NoBlocks
// [4, block]    — Block
// [5]           — BatchDone

export const BlockFetchMessageBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(BlockFetchMessage, {
    decode: SchemaGetter.transform((cbor: CborSchemaType) => {
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
          const block = cbor.items[1];
          if (block?._tag !== CborKinds.Bytes) throw new Error("Expected bytes for block");
          return { _tag: BlockFetchMessageType.Block as const, block: block.bytes };
        }
        case 5:
          return { _tag: BlockFetchMessageType.BatchDone as const };
        default:
          throw new Error(`Unknown BlockFetch tag: ${Number(tag.num)}`);
      }
    }),
    encode: SchemaGetter.transform(
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
    ),
  }),
);
