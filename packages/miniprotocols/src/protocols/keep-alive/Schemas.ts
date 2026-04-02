import { Schema, SchemaGetter } from "effect";

import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema";

// ── Application-level types ──

export enum KeepAliveMessageType {
  KeepAlive = "KeepAlive",
  KeepAliveResponse = "KeepAliveResponse",
  Done = "Done",
}

export const KeepAliveMessageTypeSchema = Schema.Enum(KeepAliveMessageType);

export const KeepAliveMessage = Schema.Union([
  Schema.TaggedStruct(KeepAliveMessageType.KeepAlive, {
    cookie: Schema.Number,
  }),
  Schema.TaggedStruct(KeepAliveMessageType.KeepAliveResponse, {
    cookie: Schema.Number,
  }),
  Schema.TaggedStruct(KeepAliveMessageType.Done, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type KeepAliveMessageT = Schema.Schema.Type<typeof KeepAliveMessage>;

// ── CBOR wire format ──
// [0, cookie] — KeepAlive
// [1, cookie] — KeepAliveResponse
// [2]         — Done

export const KeepAliveMessageBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(KeepAliveMessage, {
    decode: SchemaGetter.transform((cbor: CborSchemaType) => {
      if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
      const tag = cbor.items[0];
      if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
      switch (Number(tag.num)) {
        case 0: return { _tag: KeepAliveMessageType.KeepAlive as const, cookie: Number((cbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num) };
        case 1: return { _tag: KeepAliveMessageType.KeepAliveResponse as const, cookie: Number((cbor.items[1] as Extract<CborSchemaType, { _tag: CborKinds.UInt }>).num) };
        default: return { _tag: KeepAliveMessageType.Done as const };
      }
    }),
    encode: SchemaGetter.transform(
      KeepAliveMessage.match({
        KeepAlive: (m): CborSchemaType => ({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 0n }, { _tag: CborKinds.UInt, num: BigInt(m.cookie) }] }),
        KeepAliveResponse: (m): CborSchemaType => ({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 1n }, { _tag: CborKinds.UInt, num: BigInt(m.cookie) }] }),
        Done: (): CborSchemaType => ({ _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 2n }] }),
      }),
    ),
  }),
);
