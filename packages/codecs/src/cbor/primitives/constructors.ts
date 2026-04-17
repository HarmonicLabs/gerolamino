import { CborKinds, type CborValue, CborValue as CborValueSchema } from "../CborValue";

// ────────────────────────────────────────────────────────────────────────────
// CBOR value constructors — thin builders for producing IR nodes ergonomically.
// Every constructor routes through `CborValueSchema.make(...)` so that the
// returned CborValue is typechecked against the tagged-union schema rather
// than relying on structural compatibility alone.
// ────────────────────────────────────────────────────────────────────────────

export const cborUintValue = (n: bigint | number): CborValue =>
  CborValueSchema.make({ _tag: CborKinds.UInt, num: BigInt(n) });

export const cborNegIntValue = (n: bigint | number): CborValue =>
  CborValueSchema.make({ _tag: CborKinds.NegInt, num: BigInt(n) });

export const cborBytesValue = (bytes: Uint8Array): CborValue =>
  CborValueSchema.make({ _tag: CborKinds.Bytes, bytes });

export const cborTextValue = (text: string): CborValue =>
  CborValueSchema.make({ _tag: CborKinds.Text, text });

export const cborArrayValue = (items: readonly CborValue[]): CborValue =>
  CborValueSchema.make({ _tag: CborKinds.Array, items });

export const cborMapValue = (
  entries: readonly { readonly k: CborValue; readonly v: CborValue }[],
): CborValue => CborValueSchema.make({ _tag: CborKinds.Map, entries });

export const cborTagValue = (tag: bigint | number, data: CborValue): CborValue =>
  CborValueSchema.make({ _tag: CborKinds.Tag, tag: BigInt(tag), data });

export const cborBoolValue = (b: boolean): CborValue =>
  CborValueSchema.make({ _tag: CborKinds.Simple, value: b });

export const cborNullValue: CborValue = CborValueSchema.make({
  _tag: CborKinds.Simple,
  value: null,
});
export const cborUndefinedValue: CborValue = CborValueSchema.make({
  _tag: CborKinds.Simple,
  value: undefined,
});
