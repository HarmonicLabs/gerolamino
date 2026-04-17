import { Schema } from "effect";
import { MemPackDecodeError } from "../MemPackError";
import { decodeOnlyMemPackBytes } from "../derive";
import type { DecodedUTxOKey } from "./schemas";
import { DecodedUTxOKey as DecodedUTxOKeySchema } from "./schemas";

/**
 * LMDB UTxO key = 32-byte TxId (blake2b-256 of tx body CBOR) + 2-byte
 * big-endian TxIx (Word16). Total 34 bytes, fixed-width.
 *
 * Note: the TxIx is encoded BIG-ENDIAN here (not little-endian) because
 * this key-comparator expects lexicographic byte order to match numerical
 * order on (TxId, TxIx) tuples — only big-endian achieves that.
 */
export const decodeMemPackKey = (buf: Uint8Array): DecodedUTxOKey => {
  if (buf.length !== 34) {
    throw new MemPackDecodeError({
      cause: `LMDB key: expected 34 bytes, got ${buf.length}`,
    });
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return DecodedUTxOKeySchema.make({
    txId: buf.slice(0, 32),
    txIx: view.getUint16(32, false), // big-endian
  });
};

/**
 * Schema-native lift of the LMDB UTxO-key decoder. Use this inside
 * `Schema.decodeEffect` / `Schema.decodeSync` pipelines. Decode-only;
 * encode fails at runtime with a structured `SchemaIssue`.
 */
export const DecodedUTxOKeyFromBytes: Schema.Codec<
  DecodedUTxOKey,
  Uint8Array<ArrayBufferLike>,
  never,
  never
> = decodeOnlyMemPackBytes("LmdbUTxOKey", DecodedUTxOKeySchema, decodeMemPackKey);
