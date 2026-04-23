import type { MemPackCodec } from "../MemPackCodec";
/**
 * Fixed-length heterogeneous tuple codec. Concatenation with no separator —
 * offset threading walks the buffer through each element's codec in order.
 *
 * Mirrors the Haskell tuple instances at
 * `~/code/reference/mempack/src/Data/MemPack.hs:853-939`.
 *
 * Typed via variadic tuples so `tuple(word8, varLen, bool)` infers
 * `MemPackCodec<readonly [number, bigint, boolean]>`.
 *
 * All three hot-path operations fold over `items` with
 * `Array.prototype.reduce`, threading `size`/`pos` through the accumulator.
 * Decode appends each element to a scoped `out` local inside the reduce
 * callback — keeps the pass O(n) without the O(n²) cost of immutable
 * spread-copy, while the reduce itself remains pure-in-accumulator. The
 * `reify` helper restates the final array's static tuple shape.
 */
export declare const tuple: <Ts extends ReadonlyArray<unknown>>(...items: { readonly [K in keyof Ts]: MemPackCodec<Ts[K]>; }) => MemPackCodec<Readonly<Ts>>;
//# sourceMappingURL=tuples.d.ts.map