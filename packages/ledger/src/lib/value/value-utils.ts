/**
 * Value arithmetic and comparison utilities.
 *
 * Pure functions operating on the existing Value Schema type.
 * Supports both ADA-only and multi-asset values.
 */
import type { Value, MultiAssetEntry } from "./value.ts";

// ---------------------------------------------------------------------------
// Coin (ADA) utilities
// ---------------------------------------------------------------------------

/** Extract the lovelace (ADA) amount from a Value. */
export function lovelaces(v: Value): bigint {
  return v.coin;
}

// ---------------------------------------------------------------------------
// Multi-asset merge helper
// ---------------------------------------------------------------------------

function mergeMultiAsset(
  a: ReadonlyArray<MultiAssetEntry> | undefined,
  b: ReadonlyArray<MultiAssetEntry> | undefined,
  op: (x: bigint, y: bigint) => bigint,
): ReadonlyArray<MultiAssetEntry> | undefined {
  if (!a && !b) return undefined;
  if (!a)
    return b?.map((e) => ({
      ...e,
      assets: e.assets.map((a) => ({ ...a, quantity: op(0n, a.quantity) })),
    }));
  if (!b) return a;

  // Build policy → asset → quantity map
  const merged = new Map<string, Map<string, bigint>>();

  const addEntries = (entries: ReadonlyArray<MultiAssetEntry>, opFn: (qty: bigint) => bigint) => {
    for (const entry of entries) {
      const policyHex = entry.policy.toHex();
      let assetMap = merged.get(policyHex);
      if (!assetMap) {
        assetMap = new Map();
        merged.set(policyHex, assetMap);
      }
      for (const asset of entry.assets) {
        const nameHex = asset.name.toHex();
        const existing = assetMap.get(nameHex) ?? 0n;
        assetMap.set(nameHex, op(existing, opFn(asset.quantity)));
      }
    }
  };

  addEntries(a, (q) => q);
  addEntries(b, (q) => q);

  // Convert back to MultiAssetEntry array, filtering zero quantities
  const result: MultiAssetEntry[] = [];
  for (const [policyHex, assetMap] of merged) {
    const assets: Array<{ name: Uint8Array; quantity: bigint }> = [];
    for (const [nameHex, qty] of assetMap) {
      if (qty !== 0n) {
        assets.push({ name: Uint8Array.fromHex(nameHex), quantity: qty });
      }
    }
    if (assets.length > 0) {
      result.push({ policy: Uint8Array.fromHex(policyHex), assets });
    }
  }
  return result.length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** Add two Values (coin + multi-asset). */
export function valueAdd(a: Value, b: Value): Value {
  return {
    coin: a.coin + b.coin,
    multiAsset: mergeMultiAsset(a.multiAsset, b.multiAsset, (x, y) => x + y),
  };
}

/** Subtract b from a. Coin may go negative (caller should validate). */
export function valueSubtract(a: Value, b: Value): Value {
  return {
    coin: a.coin - b.coin,
    multiAsset: mergeMultiAsset(a.multiAsset, b.multiAsset, (x, y) => x - y),
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
