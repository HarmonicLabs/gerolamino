import { Option } from "effect";
import type { MemPackCodec } from "../MemPackCodec";
import { MemPackDecodeError } from "../MemPackError";
import { length } from "./varlen";

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
export const list = <A>(item: MemPackCodec<A>): MemPackCodec<ReadonlyArray<A>> => ({
  typeName: `List(${item.typeName})`,
  packedByteCount: (xs) =>
    xs.reduce(
      (size, x) => size + item.packedByteCount(x),
      length.packedByteCount(xs.length),
    ),
  packInto: (xs, view, offset) =>
    xs.reduce(
      (pos, x) => item.packInto(x, view, pos),
      length.packInto(xs.length, view, offset),
    ),
  unpack: (view, offset) => {
    const { value: rawLength, offset: afterLen } = length.unpack(view, offset);
    // `length` is non-negative by construction; this guard defends against
    // corrupt input by folding the bounds check into an Option pipeline.
    const count = Option.some(rawLength).pipe(
      Option.filter((m) => m >= 0),
      Option.getOrThrowWith(
        () => new MemPackDecodeError({ cause: `List: negative length ${rawLength}` }),
      ),
    );
    let pos = afterLen;
    const out = Array.from({ length: count }, () => {
      const { value, offset: next } = item.unpack(view, pos);
      pos = next;
      return value;
    });
    return { value: out, offset: pos };
  },
});
