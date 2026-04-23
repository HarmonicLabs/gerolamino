import type { DecodedValue } from "./schemas";
/**
 * CompactValue = tag(0)=AdaOnly | tag(1)=MultiAsset. The AdaOnly variant is
 * a single `VarLen coin`; the MultiAsset variant packs Coin + asset count +
 * a flat ShortByteString carrying a compact representation of the per-policy
 * asset list (see `decodeCompactMultiAsset`).
 *
 * Note: CompactValue's tags are INDEPENDENT of BabbageTxOut's tags. Inside
 * the MultiAsset variant, the coin is a raw VarLen without its own tag
 * (matching Haskell's `packCompactCoinM = packM (VarLen c)`).
 *
 * Returns a `DecodedValue` — the Schema-typed struct from `./schemas.ts`.
 */
export declare const readCompactValue: (view: DataView, offset: number) => {
    value: DecodedValue;
    offset: number;
};
//# sourceMappingURL=compact-value.d.ts.map