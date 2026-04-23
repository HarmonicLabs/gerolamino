import type { MemPackCodec } from "../MemPackCodec";
/**
 * Length-prefixed homogeneous list. Mirrors the Haskell `[a]` instance at
 * `~/code/reference/mempack/src/Data/MemPack.hs:821-851` — packs
 * `Length (length xs)` + every element's `packM` with no separator; offset
 * threading walks the buffer through each element's `packInto`/`unpack`.
 *
 * Encode-side folds `xs` with `Array.prototype.reduce`, seeded by the length
 * prefix's contribution. Decode-side allocates declaratively via
 * `Array.from({ length: n }, mapper)` — per ECMA-262 §23.1.1.1 the mapper
 * runs in ascending index order, so `pos` can be threaded through a
 * closure-captured cursor while the output array is built in one shot.
 */
export declare const list: <A>(item: MemPackCodec<A>) => MemPackCodec<ReadonlyArray<A>>;
//# sourceMappingURL=list.d.ts.map