import { Effect, Option, Schema, SchemaIssue } from "effect";
import {
  cborCodec,
  CborKinds,
  type CborSchemaType,
  type CborValue,
  CborValue as CborValueSchema,
} from "codecs";
import {
  uint,
  cborBytes,
  cborMap,
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
//
// All dispatch on the CBOR tagged union goes through `CborValueSchema.match`
// or the `expect*` helpers from `cbor-utils.ts` — never through raw
// `_tag ===` comparisons. Decoders are hoisted to module-level functions so
// there is a single level of `Effect.gen`-free composition per variant.
// ────────────────────────────────────────────────────────────────────────────

const invalid = <T>(value: T, message: string): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message }));

// Exhaustive dispatch-failure handlers for `CborValueSchema.match`. Every
// non-expected variant maps to an `InvalidValue` issue carrying the original
// CBOR value for diagnostics. The handler for the expected tag is spread on
// top of the returned object, replacing the fail-case for that tag.
const failOthers = (expected: string) =>
  ({
    [CborKinds.UInt]: (v: CborValue) => invalid(v, `Value: expected ${expected}, got UInt`),
    [CborKinds.NegInt]: (v: CborValue) => invalid(v, `Value: expected ${expected}, got NegInt`),
    [CborKinds.Bytes]: (v: CborValue) => invalid(v, `Value: expected ${expected}, got Bytes`),
    [CborKinds.Text]: (v: CborValue) => invalid(v, `Value: expected ${expected}, got Text`),
    [CborKinds.Array]: (v: CborValue) => invalid(v, `Value: expected ${expected}, got Array`),
    [CborKinds.Map]: (v: CborValue) => invalid(v, `Value: expected ${expected}, got Map`),
    [CborKinds.Tag]: (v: CborValue) => invalid(v, `Value: expected ${expected}, got Tag`),
    [CborKinds.Simple]: (v: CborValue) => invalid(v, `Value: expected ${expected}, got Simple`),
  }) as const;

const decodeAssetAmount = (entry: { k: CborSchemaType; v: CborSchemaType }) =>
  Effect.all({
    name: expectBytes(entry.k, "MultiAsset.assetName"),
    quantity: expectInt(entry.v, "MultiAsset.quantity"),
  });

const decodeMultiAssetEntry = (entry: { k: CborSchemaType; v: CborSchemaType }) =>
  Effect.all({
    policy: expectBytes(entry.k, "MultiAsset.policy"),
    assets: expectMap(entry.v, "MultiAsset.assets").pipe(
      Effect.flatMap((assets) => Effect.all(assets.map(decodeAssetAmount))),
    ),
  });

function decodeMultiAsset(
  cbor: CborSchemaType,
): Effect.Effect<readonly MultiAssetEntry[], SchemaIssue.Issue> {
  return expectMap(cbor, "MultiAsset").pipe(
    Effect.flatMap((entries) => Effect.all(entries.map(decodeMultiAssetEntry))),
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
  return cborMap(
    multiAssetToSortedEntries(ma).map((entry) => ({
      k: cborBytes(entry.policy),
      v: cborMap(
        entry.assets.map((asset) => ({
          k: cborBytes(asset.name),
          v: asset.quantity >= 0n ? uint(asset.quantity) : negInt(asset.quantity),
        })),
      ),
    })),
  );
}

export function decodeValue(cbor: CborSchemaType): Effect.Effect<Value, SchemaIssue.Issue> {
  return CborValueSchema.match({
    ...failOthers("uint or 2-element array"),
    [CborKinds.UInt]: ({ num }): Effect.Effect<Value, SchemaIssue.Issue> =>
      Effect.succeed({ coin: num }),
    [CborKinds.Array]: ({ items }): Effect.Effect<Value, SchemaIssue.Issue> =>
      items.length === 2
        ? Effect.all({
            coin: expectUint(items[0]!, "Value.coin"),
            multiAsset: decodeMultiAsset(items[1]!),
          })
        : invalid(cbor, "Value: expected 2-element array"),
  })(cbor);
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
