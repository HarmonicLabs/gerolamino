/**
 * CompactCoin = tag(0) + VarLen(Word64). Used by Babbage TxOut variants 2/3
 * (AdaOnly). The tag is always 0 — the single-variant discriminator is kept
 * for forward compatibility with future Coin extensions.
 */
export declare const readCompactCoin: (view: DataView, offset: number) => {
    coin: bigint;
    offset: number;
};
//# sourceMappingURL=compact-coin.d.ts.map