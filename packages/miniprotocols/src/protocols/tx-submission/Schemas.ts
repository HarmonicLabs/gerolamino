import { Schema, SchemaGetter } from "effect";

import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema";

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

export type TxIdAndSize = Schema.Schema.Type<typeof TxIdAndSizeSchema>;

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

export type TxSubmissionMessageT = Schema.Schema.Type<typeof TxSubmissionMessage>;

// ── CBOR wire format ──
// [0, blocking, ack, req]   — RequestTxIds
// [1, [[txId, size]*]]      — ReplyTxIds
// [2, [txId*]]              — RequestTxs
// [3, [tx*]]                — ReplyTxs
// [4]                       — Done
// [6]                       — Init

export const TxSubmissionMessageBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(TxSubmissionMessage, {
    decode: SchemaGetter.transform((cbor: CborSchemaType) => {
      if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
      const tag = cbor.items[0];
      if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
      switch (Number(tag.num)) {
        case 0:
          return {
            _tag: TxSubmissionMessageType.RequestTxIds as const,
            blocking: (cbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Simple }>)
              .value as boolean,
            ack: Number((cbor.items[2] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num),
            req: Number((cbor.items[3] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num),
          };
        case 1: {
          const idsArray = cbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Array }>;
          return {
            _tag: TxSubmissionMessageType.ReplyTxIds as const,
            ids: idsArray.items.map((pair) => {
              const pairArr = pair as Extract<CborSchemaType, { _tag: CborKinds.Array }>;
              return {
                txId: (pairArr.items[0] as Extract<CborSchemaType, { _tag: CborKinds.Bytes }>)
                  .bytes,
                size: Number(
                  (pairArr.items[1] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num,
                ),
              };
            }),
          };
        }
        case 2: {
          const txIdsArray = cbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Array }>;
          return {
            _tag: TxSubmissionMessageType.RequestTxs as const,
            txIds: txIdsArray.items.map(
              (item) => (item as Extract<CborSchemaType, { _tag: CborKinds.Bytes }>).bytes,
            ),
          };
        }
        case 3: {
          const txsArray = cbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Array }>;
          return {
            _tag: TxSubmissionMessageType.ReplyTxs as const,
            txs: txsArray.items.map(
              (item) => (item as Extract<CborSchemaType, { _tag: CborKinds.Bytes }>).bytes,
            ),
          };
        }
        case 4:
          return { _tag: TxSubmissionMessageType.Done as const };
        default:
          return { _tag: TxSubmissionMessageType.Init as const };
      }
    }),
    encode: SchemaGetter.transform(
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
    ),
  }),
);
