import { Schema } from "effect";

import { cborSyncCodec, CborKinds, type CborSchemaType } from "codecs";

// ── Application-level types ──

export enum LocalTxSubmitMessageType {
  SubmitTx = "SubmitTx",
  AcceptTx = "AcceptTx",
  RejectTx = "RejectTx",
  Done = "Done",
}

export const LocalTxSubmitMessageTypeSchema = Schema.Enum(LocalTxSubmitMessageType);

export const LocalTxSubmitMessage = Schema.Union([
  Schema.TaggedStruct(LocalTxSubmitMessageType.SubmitTx, {
    tx: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(LocalTxSubmitMessageType.AcceptTx, {}),
  Schema.TaggedStruct(LocalTxSubmitMessageType.RejectTx, {
    reason: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(LocalTxSubmitMessageType.Done, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type LocalTxSubmitMessageT = typeof LocalTxSubmitMessage.Type;

export type LocalTxSubmitResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: Uint8Array };

// ── CBOR wire format ──
// [0, tx]     — SubmitTx
// [1]         — AcceptTx
// [2, reason] — RejectTx
// [3]         — Done

export const LocalTxSubmitMessageBytes = cborSyncCodec(
  LocalTxSubmitMessage,
  (cbor) => {
    if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
    const tag = cbor.items[0];
    if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
    switch (Number(tag.num)) {
      case 0: {
        const tx = cbor.items[1];
        if (tx?._tag !== CborKinds.Bytes) throw new Error("Expected bytes for tx");
        return LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.SubmitTx].make({
          tx: tx.bytes,
        });
      }
      case 1:
        return LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.AcceptTx].make({});
      case 2: {
        const reason = cbor.items[1];
        if (reason?._tag !== CborKinds.Bytes) throw new Error("Expected bytes for reason");
        return LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.RejectTx].make({
          reason: reason.bytes,
        });
      }
      case 3:
        return LocalTxSubmitMessage.cases[LocalTxSubmitMessageType.Done].make({});
      default:
        throw new Error(`Unknown LocalTxSubmit tag: ${Number(tag.num)}`);
    }
  },
  LocalTxSubmitMessage.match({
    SubmitTx: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 0n },
        { _tag: CborKinds.Bytes, bytes: m.tx },
      ],
    }),
    AcceptTx: (): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 1n }],
    }),
    RejectTx: (m): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: 2n },
        { _tag: CborKinds.Bytes, bytes: m.reason },
      ],
    }),
    Done: (): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [{ _tag: CborKinds.UInt, num: 3n }],
    }),
  }),
);
