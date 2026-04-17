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
export const DecodedAsset = Schema.Struct({
  name: Schema.Uint8Array,
  quantity: Schema.BigInt,
});
export type DecodedAsset = typeof DecodedAsset.Type;

/** All assets minted under a single policy ID (28-byte blake2b-224 hash). */
export const DecodedPolicy = Schema.Struct({
  policy: Schema.Uint8Array,
  assets: Schema.Array(DecodedAsset),
});
export type DecodedPolicy = typeof DecodedPolicy.Type;

/** Coin + optional multi-asset bundle, matching ledger's `Value`. */
export const DecodedValue = Schema.Struct({
  coin: Schema.BigInt,
  multiAsset: Schema.optionalKey(Schema.Array(DecodedPolicy)),
});
export type DecodedValue = typeof DecodedValue.Type;

/**
 * DatumOption variant:
 *  - `_tag: 0` — on-chain datum hash (32 bytes blake2b-256)
 *  - `_tag: 1` — inline CBOR datum bytes
 */
export const DecodedDatumOption = Schema.Union([
  Schema.TaggedStruct(0, { hash: Schema.Uint8Array }),
  Schema.TaggedStruct(1, { datum: Schema.Uint8Array }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type DecodedDatumOption = typeof DecodedDatumOption.Type;

/** A Babbage-era TxOut decoded from MemPack bytes (address re-materialized). */
export const DecodedTxOut = Schema.Struct({
  address: Schema.Uint8Array,
  value: DecodedValue,
  datumOption: Schema.optionalKey(DecodedDatumOption),
  scriptRef: Schema.optionalKey(Schema.Uint8Array),
});
export type DecodedTxOut = typeof DecodedTxOut.Type;

/** LMDB UTxO-HD key: 32-byte TxId + 2-byte big-endian TxIx. */
export const DecodedUTxOKey = Schema.Struct({
  txId: Schema.Uint8Array,
  txIx: Schema.Number,
});
export type DecodedUTxOKey = typeof DecodedUTxOKey.Type;

/**
 * Intermediate datum shape produced by the Babbage Datum decoder. Converted
 * to `DecodedDatumOption` in the TxOut decoder (tag numbering is different:
 * Datum uses `_tag = "none" | "hash" | "inline"` as an internal discriminator
 * while the exposed DatumOption uses the Babbage numeric tag convention).
 */
export const DecodedInlineDatum = Schema.Union([
  Schema.TaggedStruct("none", {}),
  Schema.TaggedStruct("hash", { hash: Schema.Uint8Array }),
  Schema.TaggedStruct("inline", { data: Schema.Uint8Array }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type DecodedInlineDatum = typeof DecodedInlineDatum.Type;

/**
 * Internal intermediate: a Credential decoded from a `tag(0)=ScriptHash |
 * tag(1)=KeyHash` + 28-byte hash layout. Used only to rebuild the 57-byte
 * base address in TxOut variants 2/3.
 */
export const DecodedCredential = Schema.Struct({
  isScript: Schema.Boolean,
  hash: Schema.Uint8Array,
});
export type DecodedCredential = typeof DecodedCredential.Type;

/**
 * Internal intermediate: the 32-byte `Addr28Extra` payload decoded into its
 * payment-hash prefix + low-bit flags. Used to rebuild a full base address
 * alongside a `DecodedCredential`.
 */
export const DecodedAddr28Extra = Schema.Struct({
  paymentHash: Schema.Uint8Array,
  isScript: Schema.Boolean,
  isMainnet: Schema.Boolean,
});
export type DecodedAddr28Extra = typeof DecodedAddr28Extra.Type;
