import type { MemPackCodec } from "../MemPackCodec";

/**
 * Centralized type-erasure bridge: a positional `unknown[]` carries the
 * right runtime shape for `Readonly<Ts>`, but TypeScript has no structural
 * way to express "array whose `i`-th element is `Ts[i]`" — the variadic
 * `Ts` is a compile-time construct with no runtime counterpart. The single
 * `as unknown as` cast is quarantined here behind a named helper so call
 * sites stay declarative.
 */
const reify = <Us extends ReadonlyArray<unknown>>(values: ReadonlyArray<unknown>): Readonly<Us> =>
  values as unknown as Readonly<Us>;

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
export const tuple = <Ts extends ReadonlyArray<unknown>>(
  ...items: { readonly [K in keyof Ts]: MemPackCodec<Ts[K]> }
): MemPackCodec<Readonly<Ts>> => ({
  typeName: `(${items.map((c) => c.typeName).join(", ")})`,
  packedByteCount: (vs) =>
    items.reduce((size, _item, i) => size + items[i]!.packedByteCount(vs[i]), 0),
  packInto: (vs, view, offset) =>
    items.reduce((pos, _item, i) => items[i]!.packInto(vs[i], view, pos), offset),
  unpack: (view, offset) => {
    const out: unknown[] = [];
    const finalPos = items.reduce((pos, item) => {
      const { value, offset: next } = item.unpack(view, pos);
      out.push(value);
      return next;
    }, offset);
    return { value: reify<Ts>(out), offset: finalPos };
  },
});
