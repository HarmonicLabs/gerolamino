/**
 * Shared CBOR construction and utility helpers.
 * Centralizes helpers previously duplicated across tx.ts, certs.ts, pool.ts, value.ts, script.ts.
 */
import { CborKinds, type CborSchemaType } from "cbor-schema"

// ---------------------------------------------------------------------------
// CBOR value constructors
// ---------------------------------------------------------------------------

export const uint = (n: bigint | number): CborSchemaType =>
  ({ _tag: CborKinds.UInt, num: BigInt(n) })

export const negInt = (num: bigint): CborSchemaType =>
  ({ _tag: CborKinds.NegInt, num })

export const cborBytes = (bytes: Uint8Array): CborSchemaType =>
  ({ _tag: CborKinds.Bytes, bytes })

export const cborText = (text: string): CborSchemaType =>
  ({ _tag: CborKinds.Text, text })

export const arr = (...items: ReadonlyArray<CborSchemaType>): CborSchemaType =>
  ({ _tag: CborKinds.Array, items: [...items] })

export const nullVal: CborSchemaType =
  { _tag: CborKinds.Simple, value: null }

export function mapEntry(
  key: number,
  v: CborSchemaType | undefined,
): ReadonlyArray<{ k: CborSchemaType; v: CborSchemaType }> {
  return v !== undefined ? [{ k: uint(key), v }] : []
}

// ---------------------------------------------------------------------------
// Tag(258) CBOR set handling
// Conway wraps certain collections in Tag(258, Array) to denote mathematical
// sets. Pre-Conway uses bare Arrays. These utilities handle both.
// ---------------------------------------------------------------------------

/**
 * Unwraps both bare `Array` and `Tag(258, Array)` into their items.
 * Returns undefined if the input is neither format.
 */
export function getCborSet(cbor: CborSchemaType): ReadonlyArray<CborSchemaType> | undefined {
  if (cbor._tag === CborKinds.Array) return cbor.items
  if (
    cbor._tag === CborKinds.Tag &&
    cbor.tag === 258n &&
    cbor.data._tag === CborKinds.Array
  ) {
    return cbor.data.items
  }
  return undefined
}

/**
 * Encodes items as a CBOR set, optionally wrapped in Tag(258) for Conway.
 */
export function encodeCborSet(
  items: ReadonlyArray<CborSchemaType>,
  useTag258: boolean,
): CborSchemaType {
  const array: CborSchemaType = { _tag: CborKinds.Array, items: [...items] }
  return useTag258
    ? { _tag: CborKinds.Tag, tag: 258n, data: array }
    : array
}

// ---------------------------------------------------------------------------
// CBOR null detection
// ---------------------------------------------------------------------------

export function decodeCborNull(cbor: CborSchemaType): boolean {
  return cbor._tag === CborKinds.Simple && cbor.value === null
}
