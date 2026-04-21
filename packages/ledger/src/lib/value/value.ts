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
// Represented as arrays of tuples for CBOR map compatibility.
export const MultiAssetEntry = Schema.Struct({
  policy: PolicyIdBytes28,
  assets: Schema.Array(
    Schema.Struct({
      name: AssetName,
      quantity: Schema.BigInt,
    }),
  ),
});
export type MultiAssetEntry = typeof MultiAssetEntry.Type;

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

// RFC 8949 canonical order on byte strings: shorter length first, then
// bytewise lex. Cardano additionally requires MultiAsset outer keys sorted
// on policy-id bytes and inner keys on asset-name bytes. Any encode path
// that forwards insertion order diverges from the on-wire TxId of the same
// logical value — wallet-visible bug.
const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
};

export function multiAssetToSortedEntries(
  ma: readonly MultiAssetEntry[],
): readonly MultiAssetEntry[] {
  return ma
    .map((entry) => ({
      policy: entry.policy,
      assets: entry.assets.toSorted((a, b) => compareBytes(a.name, b.name)),
    }))
    .toSorted((a, b) => compareBytes(a.policy, b.policy));
}

function encodeMultiAsset(ma: readonly MultiAssetEntry[]): CborSchemaType {
  const sorted = multiAssetToSortedEntries(ma);
  return {
    _tag: CborKinds.Map,
    entries: sorted.map((entry): { k: CborSchemaType; v: CborSchemaType } => ({
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

export function encodeValue(value: Value): Effect.Effect<CborSchemaType, SchemaIssue.Issue> {
  if (value.multiAsset === undefined || value.multiAsset.length === 0)
    return Effect.succeed(uint(value.coin));

  return Effect.succeed(arr(uint(value.coin), encodeMultiAsset(value.multiAsset)));
}

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codec
// ────────────────────────────────────────────────────────────────────────────

export const ValueBytes = cborCodec(Value, decodeValue, encodeValue);
