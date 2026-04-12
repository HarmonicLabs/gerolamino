import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema";

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

// Checked Uint8Array schemas (usable inside TaggedStruct/Union fields)
export const Bytes28 = Schema.Uint8Array.pipe(Schema.check(isByteLength(28)));
export const Bytes32 = Schema.Uint8Array.pipe(Schema.check(isByteLength(32)));
export const Bytes64 = Schema.Uint8Array.pipe(Schema.check(isByteLength(64)));

// ────────────────────────────────────────────────────────────────────────────
// TaggedClass hash wrappers — rich objects with utility methods
//
// Wrap a validated Uint8Array in Schema.TaggedClass for .toHex(), .equals(),
// and static .fromHex(). Existing Bytes28/Bytes32/Bytes64 schemas remain
// unchanged so all downstream Schema definitions keep working as-is.
// ────────────────────────────────────────────────────────────────────────────

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class HashObj28 extends Schema.TaggedClass<HashObj28>()("Hash28", {
  bytes: Schema.Uint8Array.pipe(Schema.check(isByteLength(28))),
}) {
  toHex(): string {
    return this.bytes.toHex();
  }
  equals(other: HashObj28): boolean {
    return bytesEqual(this.bytes, other.bytes);
  }
  static fromHex(hex: string): HashObj28 {
    return new HashObj28({ bytes: Uint8Array.fromHex(hex.startsWith("0x") ? hex.slice(2) : hex) });
  }
}

export class HashObj32 extends Schema.TaggedClass<HashObj32>()("Hash32", {
  bytes: Schema.Uint8Array.pipe(Schema.check(isByteLength(32))),
}) {
  toHex(): string {
    return this.bytes.toHex();
  }
  equals(other: HashObj32): boolean {
    return bytesEqual(this.bytes, other.bytes);
  }
  static fromHex(hex: string): HashObj32 {
    return new HashObj32({ bytes: Uint8Array.fromHex(hex.startsWith("0x") ? hex.slice(2) : hex) });
  }
}

export class SignatureObj extends Schema.TaggedClass<SignatureObj>()("Signature", {
  bytes: Schema.Uint8Array.pipe(Schema.check(isByteLength(64))),
}) {
  toHex(): string {
    return this.bytes.toHex();
  }
  equals(other: SignatureObj): boolean {
    return bytesEqual(this.bytes, other.bytes);
  }
  static fromHex(hex: string): SignatureObj {
    return new SignatureObj({ bytes: Uint8Array.fromHex(hex.startsWith("0x") ? hex.slice(2) : hex) });
  }
}

// Conversion helpers — bridge raw Uint8Array ↔ TaggedClass
export function wrapHash28(bytes: Uint8Array): HashObj28 {
  return new HashObj28({ bytes });
}
export function unwrapHash28(h: HashObj28): Uint8Array {
  return h.bytes;
}
export function wrapHash32(bytes: Uint8Array): HashObj32 {
  return new HashObj32({ bytes });
}
export function unwrapHash32(h: HashObj32): Uint8Array {
  return h.bytes;
}
export function wrapSignature(bytes: Uint8Array): SignatureObj {
  return new SignatureObj({ bytes });
}
export function unwrapSignature(s: SignatureObj): Uint8Array {
  return s.bytes;
}

// ────────────────────────────────────────────────────────────────────────────
// Base hash types (branded Uint8Array with length checks)
// ────────────────────────────────────────────────────────────────────────────

export const Hash28 = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(28)),
  Schema.brand("Hash28"),
);
export type Hash28 = typeof Hash28.Type;

export const Hash32 = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(32)),
  Schema.brand("Hash32"),
);
export type Hash32 = typeof Hash32.Type;

export const Signature = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(64)),
  Schema.brand("Signature"),
);
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
// CBOR Codecs
// ────────────────────────────────────────────────────────────────────────────

function decodeCborBytes(
  cbor: CborSchemaType,
  context: string,
  expectedLength?: number,
): Effect.Effect<Uint8Array, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Bytes)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: `${context}: expected CBOR bytes`,
      }),
    );
  if (expectedLength !== undefined && cbor.bytes.length !== expectedLength)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: `${context}: expected ${expectedLength} bytes, got ${cbor.bytes.length}`,
      }),
    );
  return Effect.succeed(cbor.bytes);
}

function encodeBytesToCbor(bytes: Uint8Array): CborSchemaType {
  return { _tag: CborKinds.Bytes, bytes };
}

export const Hash28Bytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Hash28, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      decodeCborBytes(cbor, "Hash28", 28),
    ),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
);

export const Hash32Bytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Hash32, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      decodeCborBytes(cbor, "Hash32", 32),
    ),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
);

export const SignatureBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Signature, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      decodeCborBytes(cbor, "Signature", 64),
    ),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
);

export const KeyHashBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(KeyHash, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      decodeCborBytes(cbor, "KeyHash", 28),
    ),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
);

export const ScriptHashBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(ScriptHash, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      decodeCborBytes(cbor, "ScriptHash", 28),
    ),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
);

export const PolicyIdBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(PolicyId, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      decodeCborBytes(cbor, "PolicyId", 28),
    ),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
);

export const TxIdBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(TxId, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      decodeCborBytes(cbor, "TxId", 32),
    ),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
);

export const DataHashBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(DataHash, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      decodeCborBytes(cbor, "DataHash", 32),
    ),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
);

export const DocHashBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(DocHash, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      decodeCborBytes(cbor, "DocHash", 32),
    ),
    encode: SchemaGetter.transform(encodeBytesToCbor),
  }),
);
