import { Schema } from "effect";
import { toCodecCbor, toCodecCborBytes } from "codecs";
import { Bytes28 } from "./hashes.ts";

// ────────────────────────────────────────────────────────────────────────────
// Credential — KeyHash | Script discriminated union.
//
// There are TWO wire encodings depending on context (per
// reference_mithril_state_cbor.md):
//
//   Block / CDDL CBOR: [0, keyhash] | [1, scripthash]  — tag 0 = KeyHash
//   Ledger state CBOR: [0, scripthash] | [1, keyhash]  — tag 0 = Script
//
// Two sibling schemas with independent enum-to-int mappings. No runtime
// branching — every call site picks the correct codec for its context.
// ────────────────────────────────────────────────────────────────────────────

export enum CredentialKind {
  KeyHash = 0,
  Script = 1,
}

export const Credential = Schema.Union([
  Schema.TaggedStruct(CredentialKind.KeyHash, { hash: Bytes28 }),
  Schema.TaggedStruct(CredentialKind.Script, { hash: Bytes28 }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type Credential = typeof Credential.Type;

export enum StateCredentialKind {
  Script = 0,
  KeyHash = 1,
}

export const StateCredential = Schema.Union([
  Schema.TaggedStruct(StateCredentialKind.Script, { hash: Bytes28 }),
  Schema.TaggedStruct(StateCredentialKind.KeyHash, { hash: Bytes28 }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type StateCredential = typeof StateCredential.Type;

// ────────────────────────────────────────────────────────────────────────────
// CBOR codecs — `*Bytes` for whole-byte round-trips (block/CDDL level);
// `*Cbor` for `CborValue`-level composition inside larger derived links
// (consumed by certs.ts's MIRTarget for map-key encoding).
// ────────────────────────────────────────────────────────────────────────────

export const CredentialBytes = toCodecCborBytes(Credential);
export const StateCredentialBytes = toCodecCborBytes(StateCredential);

export const CredentialCbor = toCodecCbor(Credential);
export const StateCredentialCbor = toCodecCbor(StateCredential);
