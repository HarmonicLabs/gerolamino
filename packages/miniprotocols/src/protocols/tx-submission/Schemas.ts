import { Schema } from "effect";

import {
  cborSyncCodec,
  CborKinds,
  type CborSchemaType,
  cborUint,
  cborBytes,
  cborBool,
  cborArray,
} from "codecs";

// ── Application-level types ──

export enum TxSubmissionMessageType {
  RequestTxIds = "RequestTxIds",
  ReplyTxIds = "ReplyTxIds",
  RequestTxs = "RequestTxs",
  ReplyTxs = "ReplyTxs",
  Done = "Done",
  Init = "Init",
}

export const TxSubmissionMessageTypeSchema = Schema.Enum(TxSubmissionMessageType);

export const TxIdAndSizeSchema = Schema.Struct({
  txId: Schema.Uint8Array,
  size: Schema.Number,
});

export type TxIdAndSize = typeof TxIdAndSizeSchema.Type;

export const TxSubmissionMessage = Schema.Union([
  Schema.TaggedStruct(TxSubmissionMessageType.RequestTxIds, {
    blocking: Schema.Boolean,
    ack: Schema.Number,
    req: Schema.Number,
  }),
  Schema.TaggedStruct(TxSubmissionMessageType.ReplyTxIds, {
    ids: Schema.Array(TxIdAndSizeSchema),
  }),
  Schema.TaggedStruct(TxSubmissionMessageType.RequestTxs, {
    txIds: Schema.Array(Schema.Uint8Array),
  }),
  Schema.TaggedStruct(TxSubmissionMessageType.ReplyTxs, {
    txs: Schema.Array(Schema.Uint8Array),
  }),
  Schema.TaggedStruct(TxSubmissionMessageType.Done, {}),
  Schema.TaggedStruct(TxSubmissionMessageType.Init, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type TxSubmissionMessageT = typeof TxSubmissionMessage.Type;

// ── CBOR wire format ──
// [0, blocking, ack, req]   — RequestTxIds
// [1, [[txId, size]*]]      — ReplyTxIds
// [2, [txId*]]              — RequestTxs
// [3, [tx*]]                — ReplyTxs
// [4]                       — Done
// [6]                       — Init

export const TxSubmissionMessageBytes = cborSyncCodec(
  TxSubmissionMessage,
  (cbor) => {
    if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
    const tag = cbor.items[0];
    if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
    switch (Number(tag.num)) {
      case 0:
        return {
          _tag: TxSubmissionMessageType.RequestTxIds as const,
          blocking: cborBool(cbor.items[1]!, "RequestTxIds blocking"),
          ack: Number(cborUint(cbor.items[2]!, "RequestTxIds ack")),
          req: Number(cborUint(cbor.items[3]!, "RequestTxIds req")),
        };
      case 1: {
        const idsItems = cborArray(cbor.items[1]!, "ReplyTxIds ids");
        return {
          _tag: TxSubmissionMessageType.ReplyTxIds as const,
          ids: idsItems.map((pair) => {
            const pairItems = cborArray(pair, "ReplyTxIds pair");
            return {
              txId: cborBytes(pairItems[0]!, "txId"),
              size: Number(cborUint(pairItems[1]!, "size")),
            };
          }),
        };
      }
      case 2: {
        const txIdsItems = cborArray(cbor.items[1]!, "RequestTxs txIds");
        return {
          _tag: TxSubmissionMessageType.RequestTxs as const,
          txIds: txIdsItems.map((item) => cborBytes(item, "txId")),
        };
      }
      case 3: {
        const txsItems = cborArray(cbor.items[1]!, "ReplyTxs txs");
        return {
          _tag: TxSubmissionMessageType.ReplyTxs as const,
          txs: txsItems.map((item) => cborBytes(item, "tx")),
        };
      }
      case 4:
        return { _tag: TxSubmissionMessageType.Done as const };
      default:
        return { _tag: TxSubmissionMessageType.Init as const };
    }
  },
  TxSubmissionMessage.match({
    RequestTxIds: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 0n },
        { _tag: CborKinds.Simple, value: m.blocking },
        { _tag: CborKinds.UInt, num: BigInt(m.ack) },
        { _tag: CborKinds.UInt, num: BigInt(m.req) },
      ],
    }),
    ReplyTxIds: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 1n },
        {
          _tag: CborKinds.Array,
          items: m.ids.map(
            (id): CborSchemaType => ({
              _tag: CborKinds.Array,
              items: [
                { _tag: CborKinds.Bytes, bytes: id.txId },
                { _tag: CborKinds.UInt, num: BigInt(id.size) },
              ],
            }),
          ),
        },
      ],
    }),
    RequestTxs: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 2n },
        {
          _tag: CborKinds.Array,
          items: m.txIds.map(
            (txId): CborSchemaType => ({ _tag: CborKinds.Bytes, bytes: txId }),
          ),
        },
      ],
    }),
    ReplyTxs: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 3n },
        {
          _tag: CborKinds.Array,
          items: m.txs.map((tx): CborSchemaType => ({ _tag: CborKinds.Bytes, bytes: tx })),
        },
      ],
    }),
    Done: (): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 4n }],
    }),
    Init: (): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 6n }],
    }),
  }),
);
