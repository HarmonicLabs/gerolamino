import { Schema } from "effect";
import type { DecodedUTxOKey } from "./schemas";
/**
 * LMDB UTxO key = 32-byte TxId (blake2b-256 of tx body CBOR) + 2-byte
 * big-endian TxIx (Word16). Total 34 bytes, fixed-width.
 *
 * Note: the TxIx is encoded BIG-ENDIAN here (not little-endian) because
 * this key-comparator expects lexicographic byte order to match numerical
 * order on (TxId, TxIx) tuples — only big-endian achieves that.
 */
export declare const decodeMemPackKey: (buf: Uint8Array) => DecodedUTxOKey;
/**
 * Schema-native lift of the LMDB UTxO-key decoder. Use this inside
 * `Schema.decodeEffect` / `Schema.decodeSync` pipelines. Decode-only;
 * encode fails at runtime with a structured `SchemaIssue`.
 */
export declare const DecodedUTxOKeyFromBytes: Schema.Codec<DecodedUTxOKey, Uint8Array<ArrayBufferLike>, never, never>;
//# sourceMappingURL=key.d.ts.map