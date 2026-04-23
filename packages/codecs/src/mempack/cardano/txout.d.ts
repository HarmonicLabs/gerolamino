import { Schema } from "effect";
import type { DecodedTxOut } from "./schemas";
/**
 * Decode a Babbage-era TxOut from Haskell's MemPack binary format — the
 * on-disk layout used by Cardano's UTxO-HD LMDB backend. Matches the
 * reference at `cardano-ledger/eras/babbage/impl/src/Cardano/Ledger/Babbage/TxOut.hs`.
 *
 * Six tag variants:
 *   0: TxOutCompact              = CompactAddr + CompactValue
 *   1: TxOutCompactDH            = CompactAddr + CompactValue + DataHash(32B)
 *   2: TxOut_AddrHash28_AdaOnly  = Credential + Addr28Extra(32B) + CompactCoin
 *   3: TxOut_AddrHash28_AdaOnly_DH32 = variant 2 + DataHash(32B)
 *   4: TxOutCompactDatum         = CompactAddr + CompactValue + BinaryData
 *   5: TxOutCompactRefScript     = CompactAddr + CompactValue + Datum + Script
 *
 * The returned value satisfies the `DecodedTxOut` Schema (see `./schemas.ts`)
 * — compose with `decodedTxOutFromBytes` below when you want a full
 * `Schema.Codec<DecodedTxOut, Uint8Array<ArrayBufferLike>>` for the Effect
 * pipeline (decode-only; encode is not implemented).
 */
export declare const decodeMemPackTxOut: (buf: Uint8Array) => DecodedTxOut;
/**
 * Schema-native lift of the Babbage TxOut decoder. Use this inside
 * `Schema.decodeEffect` / `Schema.decodeSync` pipelines — the underlying
 * bytewise decoder is `decodeMemPackTxOut`. Encode is not implemented and
 * fails with a structured `Issue` at runtime.
 */
export declare const DecodedTxOutFromBytes: Schema.Codec<DecodedTxOut, Uint8Array<ArrayBufferLike>, never, never>;
//# sourceMappingURL=txout.d.ts.map