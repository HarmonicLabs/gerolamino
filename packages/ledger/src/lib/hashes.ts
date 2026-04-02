import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema"

// ────────────────────────────────────────────────────────────────────────────
// Byte length filter for Uint8Array
// ────────────────────────────────────────────────────────────────────────────

export const isByteLength = (n: number) =>
  Schema.makeFilter<Uint8Array>(
    (bytes) => bytes.length === n || `expected ${n} bytes, got ${bytes.length}`,
    { expected: `Uint8Array of exactly ${n} bytes` },
  )

export const isByteMaxLength = (n: number) =>
  Schema.makeFilter<Uint8Array>(
    (bytes) => bytes.length <= n || `expected at most ${n} bytes, got ${bytes.length}`,
    { expected: `Uint8Array of at most ${n} bytes` },
  )

// Checked Uint8Array schemas (no brand, usable inside tagged unions)
export const Bytes28 = Schema.Uint8Array.pipe(Schema.check(isByteLength(28)))
export const Bytes32 = Schema.Uint8Array.pipe(Schema.check(isByteLength(32)))
export const Bytes64 = Schema.Uint8Array.pipe(Schema.check(isByteLength(64)))

// ────────────────────────────────────────────────────────────────────────────
// Base hash types (branded Uint8Array with length checks)
// ────────────────────────────────────────────────────────────────────────────

export const Hash28 = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(28)),
  Schema.brand("Hash28"),
)
export type Hash28 = Schema.Schema.Type<typeof Hash28>

export const Hash32 = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(32)),
  Schema.brand("Hash32"),
)
export type Hash32 = Schema.Schema.Type<typeof Hash32>

export const Signature = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(64)),
  Schema.brand("Signature"),
)
export type Signature = Schema.Schema.Type<typeof Signature>

// ────────────────────────────────────────────────────────────────────────────
// Domain-specific hash aliases (stacked brands for nominal type safety)
// ────────────────────────────────────────────────────────────────────────────

// 28-byte hashes
export const KeyHash = Hash28.pipe(Schema.brand("KeyHash"))
export type KeyHash = Schema.Schema.Type<typeof KeyHash>

export const ScriptHash = Hash28.pipe(Schema.brand("ScriptHash"))
export type ScriptHash = Schema.Schema.Type<typeof ScriptHash>

export const PolicyId = Hash28.pipe(Schema.brand("PolicyId"))
export type PolicyId = Schema.Schema.Type<typeof PolicyId>

export const PoolKeyHash = Hash28.pipe(Schema.brand("PoolKeyHash"))
export type PoolKeyHash = Schema.Schema.Type<typeof PoolKeyHash>

export const VRFKeyHash = Hash32.pipe(Schema.brand("VRFKeyHash"))
export type VRFKeyHash = Schema.Schema.Type<typeof VRFKeyHash>

// 32-byte hashes
export const TxId = Hash32.pipe(Schema.brand("TxId"))
export type TxId = Schema.Schema.Type<typeof TxId>

export const DataHash = Hash32.pipe(Schema.brand("DataHash"))
export type DataHash = Schema.Schema.Type<typeof DataHash>

export const AuxDataHash = Hash32.pipe(Schema.brand("AuxDataHash"))
export type AuxDataHash = Schema.Schema.Type<typeof AuxDataHash>

export const ScriptDataHash = Hash32.pipe(Schema.brand("ScriptDataHash"))
export type ScriptDataHash = Schema.Schema.Type<typeof ScriptDataHash>

export const DocHash = Hash32.pipe(Schema.brand("DocHash"))
export type DocHash = Schema.Schema.Type<typeof DocHash>

// ────────────────────────────────────────────────────────────────────────────
// CBOR Codecs — all hashes are just CBOR bytes
// ────────────────────────────────────────────────────────────────────────────

function decodeCborBytes(cbor: CborSchemaType, context: string, expectedLength?: number): Effect.Effect<Uint8Array, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Bytes)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `${context}: expected CBOR bytes` }))
  if (expectedLength !== undefined && cbor.bytes.length !== expectedLength)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `${context}: expected ${expectedLength} bytes, got ${cbor.bytes.length}` }))
  return Effect.succeed(cbor.bytes)
}

function encodeBytesToCbor(bytes: Uint8Array): CborSchemaType {
  return { _tag: CborKinds.Bytes, bytes }
}

export const Hash28Bytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Hash28, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborBytes(cbor, "Hash28", 28)),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
)

export const Hash32Bytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Hash32, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborBytes(cbor, "Hash32", 32)),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
)

export const SignatureBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Signature, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborBytes(cbor, "Signature", 64)),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
)

export const KeyHashBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(KeyHash, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborBytes(cbor, "KeyHash", 28)),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
)

export const ScriptHashBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(ScriptHash, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborBytes(cbor, "ScriptHash", 28)),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
)

export const PolicyIdBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(PolicyId, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborBytes(cbor, "PolicyId", 28)),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
)

export const TxIdBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(TxId, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborBytes(cbor, "TxId", 32)),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
)

export const DataHashBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(DataHash, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborBytes(cbor, "DataHash", 32)),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
)

export const DocHashBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(DocHash, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborBytes(cbor, "DocHash", 32)),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
)
