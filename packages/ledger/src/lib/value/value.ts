import { Effect, Option, Schema, SchemaIssue } from "effect";
import { cborCodec, CborKinds, type CborSchemaType } from "codecs";
import {
  uint,
  cborBytes,
  negInt,
  arr,
  expectUint,
  expectBytes,
  expectInt,
  expectMap,
} from "../core/cbor-utils.ts";
import { Coin } from "../core/primitives.ts";
import { isByteMaxLength } from "../core/hashes.ts";

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
);

// AssetName: up to 32 bytes
export const AssetName = Schema.Uint8Array.pipe(Schema.check(isByteMaxLength(32)));
export type AssetName = typeof AssetName.Type;

// ────────────────────────────────────────────────────────────────────────────
// Value: Coin or Coin + MultiAsset
// CBOR: uint (coin-only) or [coin, { policyId: { assetName: quantity } }]
// ────────────────────────────────────────────────────────────────────────────

// MultiAsset is a map of maps: PolicyId → (AssetName → bigint)
// Represented as arrays of tuples for CBOR map compatibility
export interface MultiAssetEntry {
  readonly policy: Uint8Array;
  readonly assets: readonly { readonly name: Uint8Array; readonly quantity: bigint }[];
}

export const MultiAssetEntry = Schema.Struct({
  policy: PolicyIdBytes28,
  assets: Schema.Array(
    Schema.Struct({
      name: AssetName,
      quantity: Schema.BigInt,
    }),
  ),
});

export const Value = Schema.Struct({
  coin: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  multiAsset: Schema.optional(Schema.Array(MultiAssetEntry)),
});
export type Value = typeof Value.Type;

// ────────────────────────────────────────────────────────────────────────────
// CBOR encoding helpers (module-private)
// ────────────────────────────────────────────────────────────────────────────

// CBOR helpers imported from cbor-utils.ts

// ────────────────────────────────────────────────────────────────────────────
// CBOR decode/encode helpers
// ────────────────────────────────────────────────────────────────────────────

function decodeMultiAsset(
  cbor: CborSchemaType,
): Effect.Effect<readonly MultiAssetEntry[], SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Map)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "MultiAsset: expected CBOR map" }),
    );

  return Effect.all(
    cbor.entries.map((entry) =>
      Effect.gen(function* () {
        const policy = yield* expectBytes(entry.k, "MultiAsset.policy");
        const assetMap = yield* expectMap(entry.v, "MultiAsset.assets");
        const assets = yield* Effect.all(
          assetMap.map((a) =>
            Effect.gen(function* () {
              const name = yield* expectBytes(a.k, "MultiAsset.assetName");
              const quantity = yield* expectInt(a.v, "MultiAsset.quantity");
              return { name, quantity };
            }),
          ),
        );
        return { policy, assets };
      }),
    ),
  );
}

function encodeMultiAsset(ma: readonly MultiAssetEntry[]): CborSchemaType {
  return {
    _tag: CborKinds.Map,
    entries: ma.map((entry): { k: CborSchemaType; v: CborSchemaType } => ({
      k: cborBytes(entry.policy),
      v: {
        _tag: CborKinds.Map,
        entries: entry.assets.map((asset): { k: CborSchemaType; v: CborSchemaType } => ({
          k: cborBytes(asset.name),
          v: asset.quantity >= 0n ? uint(asset.quantity) : negInt(asset.quantity),
        })),
      },
    })),
  };
}

export function decodeValue(cbor: CborSchemaType): Effect.Effect<Value, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    // Coin-only: just a uint
    if (cbor._tag === CborKinds.UInt) return { coin: cbor.num };
    // Multi-asset: [coin, multiasset_map]
    if (cbor._tag === CborKinds.Array && cbor.items.length === 2) {
      const coin = yield* expectUint(cbor.items[0]!, "Value.coin");
      const multiAsset = yield* decodeMultiAsset(cbor.items[1]!);
      return { coin, multiAsset };
    }
    return yield* Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: "Value: expected uint or 2-element array",
      }),
    );
  });
}

export function encodeValue(value: Value): CborSchemaType {
  if (value.multiAsset === undefined || value.multiAsset.length === 0) return uint(value.coin);

  return arr(uint(value.coin), encodeMultiAsset(value.multiAsset));
}

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codec
// ────────────────────────────────────────────────────────────────────────────

export const ValueBytes = cborCodec(Value, decodeValue, encodeValue);
