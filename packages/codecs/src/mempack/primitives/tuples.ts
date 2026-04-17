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
 */
export const tuple = <Ts extends ReadonlyArray<unknown>>(
  ...items: { readonly [K in keyof Ts]: MemPackCodec<Ts[K]> }
): MemPackCodec<Readonly<Ts>> => ({
  typeName: `(${items.map((c) => c.typeName).join(", ")})`,
  packedByteCount: (vs) => {
    let size = 0;
    for (let i = 0; i < items.length; i++) size += items[i]!.packedByteCount(vs[i]);
    return size;
  },
  packInto: (vs, view, offset) => {
    let pos = offset;
    for (let i = 0; i < items.length; i++) pos = items[i]!.packInto(vs[i], view, pos);
    return pos;
  },
  unpack: (view, offset) => {
    const out = new Array<unknown>(items.length);
    let pos = offset;
    for (let i = 0; i < items.length; i++) {
      const { value, offset: next } = items[i]!.unpack(view, pos);
      out[i] = value;
      pos = next;
    }
    return { value: out as unknown as Readonly<Ts>, offset: pos };
  },
});
