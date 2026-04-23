import { Schema } from "effect";
/**
 * Schema definitions for Babbage-era TxOut MemPack decoding results.
 *
 * These live in codecs (no reverse dependency on ledger) so any consumer —
 * storage, consensus, TUI — can decode UTxO MemPack bytes without pulling
 * ledger as a transitive dependency. Ledger's own TxOut / Value / DatumOption
 * schemas consume these structurally.
 *
 * Every type is a `Schema.Struct` / `Schema.toTaggedUnion` rather than a bare
 * TS interface so downstream code can compose them with the rest of the
 * Effect Schema ecosystem (annotations, arbitraries, equivalences, JSON round
 * trips, etc.) — see `toCodecMemPackBytes` in `mempack/derive/`.
 */
/** A single asset in a multi-asset bundle. */
export declare const DecodedAsset: Schema.Struct<{
    readonly name: Schema.Uint8Array;
    readonly quantity: Schema.BigInt;
}>;
export type DecodedAsset = typeof DecodedAsset.Type;
/** All assets minted under a single policy ID (28-byte blake2b-224 hash). */
export declare const DecodedPolicy: Schema.Struct<{
    readonly policy: Schema.Uint8Array;
    readonly assets: Schema.$Array<Schema.Struct<{
        readonly name: Schema.Uint8Array;
        readonly quantity: Schema.BigInt;
    }>>;
}>;
export type DecodedPolicy = typeof DecodedPolicy.Type;
/** Coin + optional multi-asset bundle, matching ledger's `Value`. */
export declare const DecodedValue: Schema.Struct<{
    readonly coin: Schema.BigInt;
    readonly multiAsset: Schema.optionalKey<Schema.$Array<Schema.Struct<{
        readonly policy: Schema.Uint8Array;
        readonly assets: Schema.$Array<Schema.Struct<{
            readonly name: Schema.Uint8Array;
            readonly quantity: Schema.BigInt;
        }>>;
    }>>>;
}>;
export type DecodedValue = typeof DecodedValue.Type;
/**
 * DatumOption variant:
 *  - `_tag: 0` — on-chain datum hash (32 bytes blake2b-256)
 *  - `_tag: 1` — inline CBOR datum bytes
 */
export declare const DecodedDatumOption: Schema.toTaggedUnion<"_tag", readonly [Schema.TaggedStruct<0, {
    readonly hash: Schema.Uint8Array;
}>, Schema.TaggedStruct<1, {
    readonly datum: Schema.Uint8Array;
}>]>;
export type DecodedDatumOption = typeof DecodedDatumOption.Type;
/** A Babbage-era TxOut decoded from MemPack bytes (address re-materialized). */
export declare const DecodedTxOut: Schema.Struct<{
    readonly address: Schema.Uint8Array;
    readonly value: Schema.Struct<{
        readonly coin: Schema.BigInt;
        readonly multiAsset: Schema.optionalKey<Schema.$Array<Schema.Struct<{
            readonly policy: Schema.Uint8Array;
            readonly assets: Schema.$Array<Schema.Struct<{
                readonly name: Schema.Uint8Array;
                readonly quantity: Schema.BigInt;
            }>>;
        }>>>;
    }>;
    readonly datumOption: Schema.optionalKey<Schema.toTaggedUnion<"_tag", readonly [Schema.TaggedStruct<0, {
        readonly hash: Schema.Uint8Array;
    }>, Schema.TaggedStruct<1, {
        readonly datum: Schema.Uint8Array;
    }>]>>;
    readonly scriptRef: Schema.optionalKey<Schema.Uint8Array>;
}>;
export type DecodedTxOut = typeof DecodedTxOut.Type;
/** LMDB UTxO-HD key: 32-byte TxId + 2-byte big-endian TxIx. */
export declare const DecodedUTxOKey: Schema.Struct<{
    readonly txId: Schema.Uint8Array;
    readonly txIx: Schema.Number;
}>;
export type DecodedUTxOKey = typeof DecodedUTxOKey.Type;
/**
 * Intermediate datum shape produced by the Babbage Datum decoder. Converted
 * to `DecodedDatumOption` in the TxOut decoder (tag numbering is different:
 * Datum uses `_tag = "none" | "hash" | "inline"` as an internal discriminator
 * while the exposed DatumOption uses the Babbage numeric tag convention).
 */
export declare const DecodedInlineDatum: Schema.toTaggedUnion<"_tag", readonly [Schema.TaggedStruct<"none", {}>, Schema.TaggedStruct<"hash", {
    readonly hash: Schema.Uint8Array;
}>, Schema.TaggedStruct<"inline", {
    readonly data: Schema.Uint8Array;
}>]>;
export type DecodedInlineDatum = typeof DecodedInlineDatum.Type;
/**
 * Internal intermediate: a Credential decoded from a `tag(0)=ScriptHash |
 * tag(1)=KeyHash` + 28-byte hash layout. Used only to rebuild the 57-byte
 * base address in TxOut variants 2/3.
 */
export declare const DecodedCredential: Schema.Struct<{
    readonly isScript: Schema.Boolean;
    readonly hash: Schema.Uint8Array;
}>;
export type DecodedCredential = typeof DecodedCredential.Type;
/**
 * Internal intermediate: the 32-byte `Addr28Extra` payload decoded into its
 * payment-hash prefix + low-bit flags. Used to rebuild a full base address
 * alongside a `DecodedCredential`.
 */
export declare const DecodedAddr28Extra: Schema.Struct<{
    readonly paymentHash: Schema.Uint8Array;
    readonly isScript: Schema.Boolean;
    readonly isMainnet: Schema.Boolean;
}>;
export type DecodedAddr28Extra = typeof DecodedAddr28Extra.Type;
//# sourceMappingURL=schemas.d.ts.map