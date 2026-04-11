/**
 * Crypto worker message protocol — TaggedUnion types for type-safe
 * communication between main thread and worker OS threads.
 *
 * Uses Schema.Union + TaggedStruct + toTaggedUnion for consistency
 * with ChainSyncMessage, MultiEraHeader, etc.
 */
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Request (main thread → worker)
// ---------------------------------------------------------------------------

export const enum CryptoRequestKind {
  VrfVerifyProof = "VrfVerifyProof",
  KesSum6Verify = "KesSum6Verify",
  Ed25519Verify = "Ed25519Verify",
  CheckVrfLeader = "CheckVrfLeader",
  VrfProofToHash = "VrfProofToHash",
}

export const CryptoRequest = Schema.Union([
  Schema.TaggedStruct(CryptoRequestKind.VrfVerifyProof, {
    vrfVk: Schema.Uint8Array,
    vrfProof: Schema.Uint8Array,
    vrfInput: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(CryptoRequestKind.KesSum6Verify, {
    signature: Schema.Uint8Array,
    period: Schema.Number,
    publicKey: Schema.Uint8Array,
    message: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(CryptoRequestKind.Ed25519Verify, {
    message: Schema.Uint8Array,
    signature: Schema.Uint8Array,
    publicKey: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(CryptoRequestKind.CheckVrfLeader, {
    vrfOutputHex: Schema.String,
    sigmaNumerator: Schema.String,
    sigmaDenominator: Schema.String,
    activeSlotCoeffNum: Schema.String,
    activeSlotCoeffDen: Schema.String,
  }),
  Schema.TaggedStruct(CryptoRequestKind.VrfProofToHash, {
    vrfProof: Schema.Uint8Array,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type CryptoRequest = typeof CryptoRequest.Type;

// ---------------------------------------------------------------------------
// Response (worker → main thread)
// ---------------------------------------------------------------------------

export const enum CryptoResponseKind {
  BytesResult = "BytesResult",
  BoolResult = "BoolResult",
}

export const CryptoResponse = Schema.Union([
  Schema.TaggedStruct(CryptoResponseKind.BytesResult, {
    data: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(CryptoResponseKind.BoolResult, {
    valid: Schema.Boolean,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type CryptoResponse = typeof CryptoResponse.Type;
