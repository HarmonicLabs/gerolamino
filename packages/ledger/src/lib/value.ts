import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema"
import { Coin } from "./primitives.ts"
import { isByteMaxLength } from "./hashes.ts"

// ────────────────────────────────────────────────────────────────────────────
// PolicyId and AssetName
// ────────────────────────────────────────────────────────────────────────────

// PolicyId: 28-byte script hash (reuse Bytes28 check from hashes)
// Note: PolicyId is also exported from hashes.ts as a branded type.
// Here we use the unbranded Bytes28 check for use inside value structs.
const PolicyIdBytes28 = Schema.Uint8Array.pipe(
  Schema.check(
    Schema.makeFilter<Uint8Array>(
      (b) => b.length === 28 || `PolicyId: expected 28 bytes, got ${b.length}`,
      { expected: "28-byte PolicyId" },
    ),
  ),
)

// AssetName: up to 32 bytes
export const AssetName = Schema.Uint8Array.pipe(
  Schema.check(isByteMaxLength(32)),
)
export type AssetName = Schema.Schema.Type<typeof AssetName>

// ────────────────────────────────────────────────────────────────────────────
// Value: Coin or Coin + MultiAsset
// CBOR: uint (coin-only) or [coin, { policyId: { assetName: quantity } }]
// ────────────────────────────────────────────────────────────────────────────

// MultiAsset is a map of maps: PolicyId → (AssetName → bigint)
// Represented as arrays of tuples for CBOR map compatibility
export interface MultiAssetEntry {
  readonly policy: Uint8Array
  readonly assets: readonly { readonly name: Uint8Array; readonly quantity: bigint }[]
}

export const MultiAssetEntry = Schema.Struct({
  policy: PolicyIdBytes28,
  assets: Schema.Array(Schema.Struct({
    name: AssetName,
    quantity: Schema.BigInt,
  })),
})

export const Value = Schema.Struct({
  coin: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  multiAsset: Schema.optional(Schema.Array(MultiAssetEntry)),
})
export type Value = Schema.Schema.Type<typeof Value>

// ────────────────────────────────────────────────────────────────────────────
// CBOR decode/encode helpers
// ────────────────────────────────────────────────────────────────────────────

function decodeMultiAsset(cbor: CborSchemaType): Effect.Effect<readonly MultiAssetEntry[], SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Map)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "MultiAsset: expected CBOR map" }))

  return Effect.all(
    cbor.entries.map((entry) => {
      if (entry.k._tag !== CborKinds.Bytes)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(entry.k), { message: "MultiAsset: expected bytes policyId" }))
      if (entry.v._tag !== CborKinds.Map)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(entry.v), { message: "MultiAsset: expected map of assets" }))

      const assets = entry.v.entries.map((assetEntry) => {
        if (assetEntry.k._tag !== CborKinds.Bytes)
          throw new Error("MultiAsset: expected bytes assetName")
        if (assetEntry.v._tag !== CborKinds.UInt && assetEntry.v._tag !== CborKinds.NegInt)
          throw new Error("MultiAsset: expected int quantity")
        return { name: assetEntry.k.bytes, quantity: assetEntry.v.num }
      })

      return Effect.succeed({ policy: entry.k.bytes, assets })
    }),
  )
}

function encodeMultiAsset(ma: readonly MultiAssetEntry[]): CborSchemaType {
  return {
    _tag: CborKinds.Map,
    entries: ma.map((entry) => ({
      k: { _tag: CborKinds.Bytes, bytes: entry.policy } as CborSchemaType,
      v: {
        _tag: CborKinds.Map,
        entries: entry.assets.map((asset) => ({
          k: { _tag: CborKinds.Bytes, bytes: asset.name } as CborSchemaType,
          v: (asset.quantity >= 0n
            ? { _tag: CborKinds.UInt, num: asset.quantity }
            : { _tag: CborKinds.NegInt, num: asset.quantity }) as CborSchemaType,
        })),
      } as CborSchemaType,
    })),
  }
}

export function decodeValue(cbor: CborSchemaType): Effect.Effect<Value, SchemaIssue.Issue> {
  // Coin-only: just a uint
  if (cbor._tag === CborKinds.UInt)
    return Effect.succeed({ coin: cbor.num })

  // Multi-asset: [coin, multiasset_map]
  if (cbor._tag === CborKinds.Array && cbor.items.length === 2) {
    const coinCbor = cbor.items[0]
    if (coinCbor?._tag !== CborKinds.UInt)
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Value: expected uint coin" }))
    const maCbor = cbor.items[1]
    if (!maCbor)
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Value: missing multiasset" }))
    return decodeMultiAsset(maCbor).pipe(
      Effect.map((multiAsset) => ({ coin: coinCbor.num, multiAsset })),
    )
  }

  return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Value: expected uint or 2-element array" }))
}

export function encodeValue(value: Value): CborSchemaType {
  if (value.multiAsset === undefined || value.multiAsset.length === 0)
    return { _tag: CborKinds.UInt, num: value.coin }

  return {
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: value.coin },
      encodeMultiAsset(value.multiAsset),
    ],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codec
// ────────────────────────────────────────────────────────────────────────────

export const ValueBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Value, {
    decode: SchemaGetter.transformOrFail(decodeValue),
    encode: SchemaGetter.transform(encodeValue),
  }),
)
