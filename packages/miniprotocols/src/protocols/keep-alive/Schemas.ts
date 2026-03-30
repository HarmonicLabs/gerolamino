import { Schema, SchemaGetter } from "effect";

import { CborBytes } from "cbor-schema";

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

const KeepAliveCbor = Schema.Tuple([Schema.Literal(0), Schema.Number]);
const KeepAliveResponseCbor = Schema.Tuple([Schema.Literal(1), Schema.Number]);
const DoneCbor = Schema.Tuple([Schema.Literal(2)]);

export const KeepAliveMessageFromCbor = Schema.Union([
  KeepAliveCbor,
  KeepAliveResponseCbor,
  DoneCbor,
]).pipe(
  Schema.decodeTo(KeepAliveMessage, {
    decode: SchemaGetter.transform((tuple) =>
      tuple[0] === 0
        ? { _tag: KeepAliveMessageType.KeepAlive as const, cookie: tuple[1] }
        : tuple[0] === 1
          ? {
              _tag: KeepAliveMessageType.KeepAliveResponse as const,
              cookie: tuple[1],
            }
          : { _tag: KeepAliveMessageType.Done as const },
    ),
    encode: SchemaGetter.transform((msg) =>
      msg._tag === KeepAliveMessageType.KeepAlive
        ? [0, msg.cookie]
        : msg._tag === KeepAliveMessageType.KeepAliveResponse
          ? [1, msg.cookie]
          : [2],
    ),
  }),
);

export const KeepAliveMessageBytes = CborBytes(KeepAliveMessageFromCbor);
