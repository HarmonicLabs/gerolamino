import { Schema } from "effect";

import { cborSyncCodec, CborKinds, type CborSchemaType, encodeSync } from "codecs";
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
    /** N2N hard-fork combinator era variant (0=Byron, 1=Shelley, 2=Allegra, ..., 6=Conway). */
    eraVariant: Schema.Number,
    /** Byron-specific prefix [a, b] from the N2N wrapper; undefined for non-Byron. */
    byronPrefix: Schema.optional(Schema.Tuple([Schema.Number, Schema.BigInt])),
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

export type ChainSyncMessageT = typeof ChainSyncMessage.Type;

// ── CBOR helpers for ChainPoint / ChainTip ──

function decodeChainPoint(node: CborSchemaType): ChainPoint {
  if (node._tag !== CborKinds.Array) throw new Error("Expected CBOR array for ChainPoint");
  if (node.items.length === 0) return ChainPointSchema.cases[ChainPointType.Origin].make({});
  const slot = node.items[0];
  const hash = node.items[1];
  if (slot?._tag !== CborKinds.UInt) throw new Error("Expected uint for slot");
  if (hash?._tag !== CborKinds.Bytes) throw new Error("Expected bytes for hash");
  return ChainPointSchema.cases[ChainPointType.RealPoint].make({
    slot: Number(slot.num),
    hash: hash.bytes,
  });
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

export const ChainSyncMessageBytes = cborSyncCodec(
  ChainSyncMessage,
  (cbor) => {
    if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
    const tag = cbor.items[0];
    if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
    switch (Number(tag.num)) {
      case 0:
        return ChainSyncMessage.cases[ChainSyncMessageType.RequestNext].make({});
      case 1:
        return ChainSyncMessage.cases[ChainSyncMessageType.AwaitReply].make({});
      case 2: {
        // N2N ChainSync RollForward: [2, wrappedHeader, tip]
        // wrappedHeader = [eraVariant, headerContent]
        //   Byron (variant 0):   headerContent = [[a, b], Tag(24, headerBytes)]
        //   Shelley+ (variant 1+): headerContent = Tag(24, headerBytes)
        const wrappedHeader = cbor.items[1];
        let headerBytes: Uint8Array;
        let eraVariant = 0;
        let byronPrefix: [number, bigint] | undefined;

        if (wrappedHeader?._tag === CborKinds.Array && wrappedHeader.items.length >= 2) {
          const variantNode = wrappedHeader.items[0]!;
          if (variantNode._tag === CborKinds.UInt) {
            eraVariant = Number(variantNode.num);
            const content = wrappedHeader.items[1]!;

            if (eraVariant === 0) {
              // Byron: content = [[a, b], Tag(24, headerBytes)]
              if (content._tag === CborKinds.Array && content.items.length >= 2) {
                const prefix = content.items[0]!;
                if (prefix._tag === CborKinds.Array && prefix.items.length >= 2) {
                  const a = prefix.items[0]!;
                  const b = prefix.items[1]!;
                  if (a._tag === CborKinds.UInt && b._tag === CborKinds.UInt) {
                    byronPrefix = [Number(a.num), b.num];
                  }
                }
                const inner = content.items[1]!;
                if (
                  inner._tag === CborKinds.Tag &&
                  inner.tag === 24n &&
                  inner.data._tag === CborKinds.Bytes
                ) {
                  headerBytes = inner.data.bytes;
                } else {
                  headerBytes = encodeSync(inner);
                }
              } else if (
                content._tag === CborKinds.Tag &&
                content.tag === 24n &&
                content.data._tag === CborKinds.Bytes
              ) {
                headerBytes = content.data.bytes;
              } else {
                headerBytes = encodeSync(content);
              }
            } else {
              // Shelley+ (variant 1-6): content = Tag(24, headerBytes)
              if (
                content._tag === CborKinds.Tag &&
                content.tag === 24n &&
                content.data._tag === CborKinds.Bytes
              ) {
                headerBytes = content.data.bytes;
              } else if (content._tag === CborKinds.Bytes) {
                headerBytes = content.bytes;
              } else {
                headerBytes = encodeSync(content);
              }
            }
          } else {
            // Fallback: not an era-tagged wrapper, treat as raw header
            headerBytes = encodeSync(wrappedHeader);
          }
        } else if (
          wrappedHeader?._tag === CborKinds.Tag &&
          wrappedHeader.tag === 24n &&
          wrappedHeader.data._tag === CborKinds.Bytes
        ) {
          // Direct Tag(24, Bytes) without era wrapper (N2C or legacy)
          headerBytes = wrappedHeader.data.bytes;
        } else if (wrappedHeader?._tag === CborKinds.Bytes) {
          headerBytes = wrappedHeader.bytes;
        } else {
          headerBytes = encodeSync(wrappedHeader!);
        }

        return ChainSyncMessage.cases[ChainSyncMessageType.RollForward].make({
          header: headerBytes!,
          eraVariant,
          byronPrefix,
          tip: decodeChainTip(cbor.items[2]!),
        });
      }
      case 3:
        return ChainSyncMessage.cases[ChainSyncMessageType.RollBackward].make({
          point: decodeChainPoint(cbor.items[1]!),
          tip: decodeChainTip(cbor.items[2]!),
        });
      case 4: {
        const arr = cbor.items[1];
        if (arr?._tag !== CborKinds.Array) throw new Error("Expected CBOR array for points");
        return ChainSyncMessage.cases[ChainSyncMessageType.FindIntersect].make({
          points: arr.items.map(decodeChainPoint),
        });
      }
      case 5:
        return ChainSyncMessage.cases[ChainSyncMessageType.IntersectFound].make({
          point: decodeChainPoint(cbor.items[1]!),
          tip: decodeChainTip(cbor.items[2]!),
        });
      case 6:
        return ChainSyncMessage.cases[ChainSyncMessageType.IntersectNotFound].make({
          tip: decodeChainTip(cbor.items[1]!),
        });
      case 7:
        return ChainSyncMessage.cases[ChainSyncMessageType.Done].make({});
      default:
        throw new Error(`Unknown ChainSync tag: ${Number(tag.num)}`);
    }
  },
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
        // Re-wrap as [eraVariant, Tag(24, headerBytes)] for N2N wire format
        {
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: BigInt(m.eraVariant) },
            m.eraVariant === 0 && m.byronPrefix
              ? {
                  _tag: CborKinds.Array,
                  items: [
                    {
                      _tag: CborKinds.Array,
                      items: [
                        { _tag: CborKinds.UInt, num: BigInt(m.byronPrefix[0]) },
                        { _tag: CborKinds.UInt, num: m.byronPrefix[1] },
                      ],
                    },
                    {
                      _tag: CborKinds.Tag,
                      tag: 24n,
                      data: { _tag: CborKinds.Bytes, bytes: m.header },
                    },
                  ],
                }
              : {
                  _tag: CborKinds.Tag,
                  tag: 24n,
                  data: { _tag: CborKinds.Bytes, bytes: m.header },
                },
          ],
        },
        encodeChainTip(m.tip),
      ],
    }),
    RollBackward: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 3n }, encodeChainPoint(m.point), encodeChainTip(m.tip)],
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
      items: [{ _tag: CborKinds.UInt, num: 5n }, encodeChainPoint(m.point), encodeChainTip(m.tip)],
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
);
