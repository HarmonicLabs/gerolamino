import { Schema, SchemaGetter } from "effect";

import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema";

// ── Application-level types ──

export enum LocalTxMonitorMessageType {
  Acquire = "Acquire",
  Acquired = "Acquired",
  Release = "Release",
  NextTx = "NextTx",
  ReplyNextTx = "ReplyNextTx",
  HasTx = "HasTx",
  ReplyHasTx = "ReplyHasTx",
  GetSizes = "GetSizes",
  ReplyGetSizes = "ReplyGetSizes",
  Done = "Done",
}

export const LocalTxMonitorMessageTypeSchema = Schema.Enum(LocalTxMonitorMessageType);

export const MempoolSizesSchema = Schema.Struct({
  capacity: Schema.Number,
  size: Schema.Number,
  txCount: Schema.Number,
});

export type MempoolSizes = Schema.Schema.Type<typeof MempoolSizesSchema>;

export const LocalTxMonitorMessage = Schema.Union([
  Schema.TaggedStruct(LocalTxMonitorMessageType.Acquire, {}),
  Schema.TaggedStruct(LocalTxMonitorMessageType.Acquired, {
    slot: Schema.Number,
  }),
  Schema.TaggedStruct(LocalTxMonitorMessageType.Release, {}),
  Schema.TaggedStruct(LocalTxMonitorMessageType.NextTx, {}),
  Schema.TaggedStruct(LocalTxMonitorMessageType.ReplyNextTx, {
    tx: Schema.optional(Schema.Uint8Array),
  }),
  Schema.TaggedStruct(LocalTxMonitorMessageType.HasTx, {
    txId: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(LocalTxMonitorMessageType.ReplyHasTx, {
    hasTx: Schema.Boolean,
  }),
  Schema.TaggedStruct(LocalTxMonitorMessageType.GetSizes, {}),
  Schema.TaggedStruct(LocalTxMonitorMessageType.ReplyGetSizes, {
    sizes: MempoolSizesSchema,
  }),
  Schema.TaggedStruct(LocalTxMonitorMessageType.Done, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type LocalTxMonitorMessageT = Schema.Schema.Type<typeof LocalTxMonitorMessage>;

// ── CBOR wire format ──
// [0]                       — Acquire
// [1, slot]                 — Acquired
// [2]                       — Release
// [3]                       — NextTx
// [4, tx?]                  — ReplyNextTx
// [5, txId]                 — HasTx
// [6, hasTx]                — ReplyHasTx
// [7]                       — GetSizes
// [8, capacity, size, cnt]  — ReplyGetSizes
// [9]                       — Done

export const LocalTxMonitorMessageBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(LocalTxMonitorMessage, {
    decode: SchemaGetter.transform((cbor: CborSchemaType) => {
      if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
      const tag = cbor.items[0];
      if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
      switch (Number(tag.num)) {
        case 0: return { _tag: LocalTxMonitorMessageType.Acquire as const };
        case 1: return { _tag: LocalTxMonitorMessageType.Acquired as const, slot: Number((cbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num) };
        case 2: return { _tag: LocalTxMonitorMessageType.Release as const };
        case 3: return { _tag: LocalTxMonitorMessageType.NextTx as const };
        case 4: {
          const txNode = cbor.items[1];
          return {
            _tag: LocalTxMonitorMessageType.ReplyNextTx as const,
            tx: txNode !== undefined && txNode._tag === CborKinds.Bytes ? txNode.bytes : undefined,
          };
        }
        case 5: return { _tag: LocalTxMonitorMessageType.HasTx as const, txId: (cbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Bytes }>).bytes };
        case 6: return { _tag: LocalTxMonitorMessageType.ReplyHasTx as const, hasTx: (cbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.Simple }>).value as boolean };
        case 7: return { _tag: LocalTxMonitorMessageType.GetSizes as const };
        case 8: return {
          _tag: LocalTxMonitorMessageType.ReplyGetSizes as const,
          sizes: {
            capacity: Number((cbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num),
            size: Number((cbor.items[2] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num),
            txCount: Number((cbor.items[3] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num),
          },
        };
        default: return { _tag: LocalTxMonitorMessageType.Done as const };
      }
    }),
    encode: SchemaGetter.transform(
      LocalTxMonitorMessage.match({
        Acquire: (): CborSchemaType => ({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 0n }] }),
        Acquired: (m): CborSchemaType => ({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 1n }, { _tag: CborKinds.UInt, num: BigInt(m.slot) }] }),
        Release: (): CborSchemaType => ({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 2n }] }),
        NextTx: (): CborSchemaType => ({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 3n }] }),
        ReplyNextTx: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: m.tx !== undefined
            ? [{ _tag: CborKinds.UInt, num: 4n }, { _tag: CborKinds.Bytes, bytes: m.tx }]
            : [{ _tag: CborKinds.UInt, num: 4n }],
        }),
        HasTx: (m): CborSchemaType => ({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 5n }, { _tag: CborKinds.Bytes, bytes: m.txId }] }),
        ReplyHasTx: (m): CborSchemaType => ({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 6n }, { _tag: CborKinds.Simple, value: m.hasTx }] }),
        GetSizes: (): CborSchemaType => ({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 7n }] }),
        ReplyGetSizes: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 8n },
            { _tag: CborKinds.UInt, num: BigInt(m.sizes.capacity) },
            { _tag: CborKinds.UInt, num: BigInt(m.sizes.size) },
            { _tag: CborKinds.UInt, num: BigInt(m.sizes.txCount) },
          ],
        }),
        Done: (): CborSchemaType => ({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 9n }] }),
      }),
    ),
  }),
);
