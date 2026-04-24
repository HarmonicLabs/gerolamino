import { Schema } from "effect";

import { cborSyncCodec, CborKinds, type CborSchemaType, cborUint } from "codecs";

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

export type KeepAliveMessageT = typeof KeepAliveMessage.Type;

// ── CBOR wire format ──
// [0, cookie] — KeepAlive
// [1, cookie] — KeepAliveResponse
// [2]         — Done

export const KeepAliveMessageBytes = cborSyncCodec(
  KeepAliveMessage,
  (cbor) => {
    if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
    const tag = cbor.items[0];
    if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
    switch (Number(tag.num)) {
      case 0:
        return KeepAliveMessage.cases[KeepAliveMessageType.KeepAlive].make({
          cookie: Number(cborUint(cbor.items[1]!, "KeepAlive cookie")),
        });
      case 1:
        return KeepAliveMessage.cases[KeepAliveMessageType.KeepAliveResponse].make({
          cookie: Number(cborUint(cbor.items[1]!, "KeepAliveResponse cookie")),
        });
      default:
        return KeepAliveMessage.cases[KeepAliveMessageType.Done].make({});
    }
  },
  KeepAliveMessage.match({
    KeepAlive: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 0n },
        { _tag: CborKinds.UInt, num: BigInt(m.cookie) },
      ],
    }),
    KeepAliveResponse: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 1n },
        { _tag: CborKinds.UInt, num: BigInt(m.cookie) },
      ],
    }),
    Done: (): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 2n }],
    }),
  }),
);
