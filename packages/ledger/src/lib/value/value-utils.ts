/**
 * Value arithmetic and comparison utilities.
 *
 * Pure functions operating on the existing Value Schema type.
 * Supports both ADA-only and multi-asset values.
 */
import { Data, HashMap, Option } from "effect";
import type { Value, MultiAssetEntry } from "./value.ts";

// ---------------------------------------------------------------------------
// Coin (ADA) utilities
// ---------------------------------------------------------------------------

/** Extract the lovelace (ADA) amount from a Value. */
export function lovelaces(v: Value): bigint {
  return v.coin;
}

// ---------------------------------------------------------------------------
// Multi-asset merge — monoidal over an Abelian-group quantity.
//
// PolicyKey / NameKey wrap Uint8Array in Data.Class so Effect's structural
// Equal / Hash compares byte-wise: both Equal.ts and Hash.ts branch on
// `ArrayBuffer.isView` and iterate bytes, so two PolicyKeys (or NameKeys)
// carrying identical byte sequences collide in a HashMap without any
// hex-string round-trip. Wrapping also gives a nominal type distinction
// between policy-level and asset-level keys.
// ---------------------------------------------------------------------------

class PolicyKey extends Data.Class<{ readonly bytes: Uint8Array }> {}
class NameKey extends Data.Class<{ readonly bytes: Uint8Array }> {}

type AssetMap = HashMap.HashMap<NameKey, bigint>;
type PolicyMap = HashMap.HashMap<PolicyKey, AssetMap>;

/**
 * Combine on quantities. Callers must provide a right-identity:
 *   combine(x, empty) === x
 * mergeWithMonoid uses this to leave left-only keys untouched. Right-only
 * keys are folded via combine(empty, v): addition yields v, subtraction
 * yields -v (the correct sign flip).
 *
 * `combine` need not be associative — subtraction is not a monoid; we use it
 * only to fold right-side entries into a left-side accumulator.
 */
export interface QuantityMonoid {
  readonly empty: bigint;
  readonly combine: (x: bigint, y: bigint) => bigint;
}

// Side → polymap: fold entries within a single Value additively. Two
// MultiAssetEntry sharing a policy — or two assets sharing a name within one
// entry — collapse by summing quantities. CBOR-canonical input never has
// duplicates; this only matters for user-constructed Values.

const addAssetToMap = (am: AssetMap, name: Uint8Array, q: bigint): AssetMap =>
  HashMap.modifyAt(am, new NameKey({ bytes: name }), (existing) =>
    Option.some(
      Option.match(existing, {
        onNone: () => q,
        onSome: (current) => current + q,
      }),
    ),
  );

const addEntryToPolicyMap = (pm: PolicyMap, entry: MultiAssetEntry): PolicyMap =>
  HashMap.modifyAt(pm, new PolicyKey({ bytes: entry.policy }), (existing) =>
    Option.some(
      entry.assets.reduce(
        (am, a) => addAssetToMap(am, a.name, a.quantity),
        Option.getOrElse(existing, () => HashMap.empty<NameKey, bigint>()),
      ),
    ),
  );

const entriesToPolicyMap = (entries: ReadonlyArray<MultiAssetEntry>): PolicyMap =>
  entries.reduce(addEntryToPolicyMap, HashMap.empty<PolicyKey, AssetMap>());

const policyMapToEntries = (pm: PolicyMap): ReadonlyArray<MultiAssetEntry> =>
  Array.from(pm, ([pk, am]): MultiAssetEntry => ({
    policy: pk.bytes,
    assets: Array.from(am, ([nk, q]) => ({ name: nk.bytes, quantity: q })).filter(
      (a) => a.quantity !== 0n,
    ),
  })).filter((e) => e.assets.length > 0);

/**
 * Element-wise merge of two HashMaps under a `QuantityMonoid`-shaped combiner.
 * `HashMap.union` is that-wins — no combine callback — so we fold `right`
 * into `left` via `modifyAt`:
 *
 *   out[k] = left[k]  present, right[k] absent  → left[k]     (skipped by fold)
 *   out[k] = left[k]  absent,  right[k] present → combine(empty, right[k])
 *   out[k] = both present                       → combine(left[k], right[k])
 *
 * Left-only keys are correct because the fold never visits them; the combiner's
 * right-identity (combine(x, empty) = x) is what authorises "skipping" them.
 */
const mergeWithMonoid = <K, V>(
  left: HashMap.HashMap<K, V>,
  right: HashMap.HashMap<K, V>,
  monoid: { readonly empty: V; readonly combine: (x: V, y: V) => V },
): HashMap.HashMap<K, V> =>
  HashMap.reduce(right, left, (acc, v, k) =>
    HashMap.modifyAt(acc, k, (existing) =>
      Option.some(
        Option.match(existing, {
          onNone: () => monoid.combine(monoid.empty, v),
          onSome: (l) => monoid.combine(l, v),
        }),
      ),
    ),
  );

/**
 * Merge two multi-asset bundles element-wise under a quantity monoid.
 * Zero-valued entries are pruned; an all-zero bundle collapses to
 * `undefined` to preserve the on-wire shape (coin-only Value).
 */
export function mergeMultiAsset(
  a: ReadonlyArray<MultiAssetEntry> | undefined,
  b: ReadonlyArray<MultiAssetEntry> | undefined,
  monoid: QuantityMonoid,
): ReadonlyArray<MultiAssetEntry> | undefined {
  const merged = mergeWithMonoid(
    entriesToPolicyMap(a ?? []),
    entriesToPolicyMap(b ?? []),
    {
      empty: HashMap.empty<NameKey, bigint>(),
      combine: (l, r) => mergeWithMonoid(l, r, monoid),
    },
  );
  const out = policyMapToEntries(merged);
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Canonical monoids
// ---------------------------------------------------------------------------

const additive: QuantityMonoid = { empty: 0n, combine: (x, y) => x + y };
const subtractive: QuantityMonoid = { empty: 0n, combine: (x, y) => x - y };

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** Add two Values (coin + multi-asset). */
export function valueAdd(a: Value, b: Value): Value {
  return {
    coin: a.coin + b.coin,
    multiAsset: mergeMultiAsset(a.multiAsset, b.multiAsset, additive),
  };
}

/** Subtract b from a. Coin may go negative (caller should validate). */
export function valueSubtract(a: Value, b: Value): Value {
  return {
    coin: a.coin - b.coin,
    multiAsset: mergeMultiAsset(a.multiAsset, b.multiAsset, subtractive),
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Check if a Value has zero coin and no multi-assets. */
export function valueIsZero(v: Value): boolean {
  if (v.coin !== 0n) return false;
  if (!v.multiAsset) return true;
  return v.multiAsset.every((e) => e.assets.every((a) => a.quantity === 0n));
}

/** Check if all quantities in a Value are non-negative. */
export function valueIsPositive(v: Value): boolean {
  if (v.coin < 0n) return false;
  if (!v.multiAsset) return true;
  return v.multiAsset.every((e) => e.assets.every((a) => a.quantity >= 0n));
}

/** Check if two Values are equal (same coin + same multi-assets). */
export function valueEquals(a: Value, b: Value): boolean {
  return valueIsZero(valueSubtract(a, b));
}

/** Compare Values by coin amount only (for sorting). */
export function valueCompareCoin(a: Value, b: Value): -1 | 0 | 1 {
  if (a.coin < b.coin) return -1;
  if (a.coin > b.coin) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

/** Create a Value with only ADA (no multi-assets). */
export function adaOnly(lovelace: bigint): Value {
  return { coin: lovelace };
}

/** Create an empty Value. */
export function emptyValue(): Value {
  return { coin: 0n };
}
