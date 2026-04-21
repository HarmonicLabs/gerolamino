import { Schema } from "effect";
import type * as FastCheck from "effect/testing/FastCheck";
import { cborBytesCodec } from "codecs";

// ────────────────────────────────────────────────────────────────────────────
// Byte length filter for Uint8Array
// ────────────────────────────────────────────────────────────────────────────

export const isByteLength = (n: number) =>
  Schema.makeFilter<Uint8Array>(
    (bytes) => bytes.length === n || `expected ${n} bytes, got ${bytes.length}`,
    { expected: `Uint8Array of exactly ${n} bytes` },
  );

export const isByteMaxLength = (n: number) =>
  Schema.makeFilter<Uint8Array>(
    (bytes) => bytes.length <= n || `expected at most ${n} bytes, got ${bytes.length}`,
    { expected: `Uint8Array of at most ${n} bytes` },
  );

// Fixed-length fast-check arbitrary. Default Schema.Uint8Array arbitrary
// ignores `Schema.check(isByteLength(n))`, so every length-constrained hash
// base type must override it — downstream stacked brands inherit automatically.
const arbitraryBytes = (length: number) => () => (fc: typeof FastCheck) =>
  fc.uint8Array({ minLength: length, maxLength: length });

// Checked Uint8Array schemas (usable inside TaggedStruct/Union fields).
// `toArbitrary` must be attached here because `Schema.check(isByteLength(n))`
// does not propagate to fast-check — without the override, derived property
// tests generate arbitrary-length arrays and loop forever on the length check.
export const Bytes28 = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(28)),
  Schema.annotate({ toArbitrary: arbitraryBytes(28) }),
);
export const Bytes32 = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(32)),
  Schema.annotate({ toArbitrary: arbitraryBytes(32) }),
);
export const Bytes64 = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(64)),
  Schema.annotate({ toArbitrary: arbitraryBytes(64) }),
);

// ────────────────────────────────────────────────────────────────────────────
// Base hash types — brand the corresponding `Bytes*` length-checked base
// (length filter + `toArbitrary` annotation are inherited from the Bytes
// schema; stacking `Schema.brand` preserves both).
// ────────────────────────────────────────────────────────────────────────────

export const Hash28 = Bytes28.pipe(Schema.brand("Hash28"));
export type Hash28 = typeof Hash28.Type;

export const Hash32 = Bytes32.pipe(Schema.brand("Hash32"));
export type Hash32 = typeof Hash32.Type;

export const Signature = Bytes64.pipe(Schema.brand("Signature"));
export type Signature = typeof Signature.Type;

// ────────────────────────────────────────────────────────────────────────────
// Domain-specific hash aliases (stacked brands for nominal type safety)
// ────────────────────────────────────────────────────────────────────────────

export const KeyHash = Hash28.pipe(Schema.brand("KeyHash"));
export type KeyHash = typeof KeyHash.Type;

export const ScriptHash = Hash28.pipe(Schema.brand("ScriptHash"));
export type ScriptHash = typeof ScriptHash.Type;

export const PolicyId = Hash28.pipe(Schema.brand("PolicyId"));
export type PolicyId = typeof PolicyId.Type;

export const PoolKeyHash = Hash28.pipe(Schema.brand("PoolKeyHash"));
export type PoolKeyHash = typeof PoolKeyHash.Type;

export const VRFKeyHash = Hash32.pipe(Schema.brand("VRFKeyHash"));
export type VRFKeyHash = typeof VRFKeyHash.Type;

export const TxId = Hash32.pipe(Schema.brand("TxId"));
export type TxId = typeof TxId.Type;

export const DataHash = Hash32.pipe(Schema.brand("DataHash"));
export type DataHash = typeof DataHash.Type;

export const AuxDataHash = Hash32.pipe(Schema.brand("AuxDataHash"));
export type AuxDataHash = typeof AuxDataHash.Type;

export const ScriptDataHash = Hash32.pipe(Schema.brand("ScriptDataHash"));
export type ScriptDataHash = typeof ScriptDataHash.Type;

export const DocHash = Hash32.pipe(Schema.brand("DocHash"));
export type DocHash = typeof DocHash.Type;

// ────────────────────────────────────────────────────────────────────────────
// CBOR Codecs — one per branded type, all delegate to `cborBytesCodec`.
// ────────────────────────────────────────────────────────────────────────────

export const Hash28Bytes = cborBytesCodec(Hash28, "Hash28");
export const Hash32Bytes = cborBytesCodec(Hash32, "Hash32");
export const SignatureBytes = cborBytesCodec(Signature, "Signature");
export const KeyHashBytes = cborBytesCodec(KeyHash, "KeyHash");
export const ScriptHashBytes = cborBytesCodec(ScriptHash, "ScriptHash");
export const PolicyIdBytes = cborBytesCodec(PolicyId, "PolicyId");
export const PoolKeyHashBytes = cborBytesCodec(PoolKeyHash, "PoolKeyHash");
export const VRFKeyHashBytes = cborBytesCodec(VRFKeyHash, "VRFKeyHash");
export const TxIdBytes = cborBytesCodec(TxId, "TxId");
export const DataHashBytes = cborBytesCodec(DataHash, "DataHash");
export const AuxDataHashBytes = cborBytesCodec(AuxDataHash, "AuxDataHash");
export const ScriptDataHashBytes = cborBytesCodec(ScriptDataHash, "ScriptDataHash");
export const DocHashBytes = cborBytesCodec(DocHash, "DocHash");
