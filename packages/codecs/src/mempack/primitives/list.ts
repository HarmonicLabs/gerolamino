import type { MemPackCodec } from "../MemPackCodec";
import { MemPackEncodeError } from "../MemPackError";
import { length } from "./varlen";

/**
 * Length-prefixed homogeneous list. Mirror the Haskell `[a]` instance at
 * `~/code/reference/mempack/src/Data/MemPack.hs:821-851` (packs
 * `Length (length xs)` + every element's `packM`).
 *
 * Elements are serialized in order with no separator — offset threading from
 * each element's `packInto` / `unpack` walks the buffer.
 */
export const list = <A>(item: MemPackCodec<A>): MemPackCodec<ReadonlyArray<A>> => ({
  typeName: `List(${item.typeName})`,
  packedByteCount: (xs) => {
    let size = length.packedByteCount(xs.length);
    for (const x of xs) size += item.packedByteCount(x);
    return size;
  },
  packInto: (xs, view, offset) => {
    let pos = length.packInto(xs.length, view, offset);
    for (const x of xs) pos = item.packInto(x, view, pos);
    return pos;
  },
  unpack: (view, offset) => {
    const { value: n, offset: afterLen } = length.unpack(view, offset);
    if (n < 0) {
      throw new MemPackEncodeError({ cause: `List: negative length ${n}` });
    }
    const out = new Array<A>(n);
    let pos = afterLen;
    for (let i = 0; i < n; i++) {
      const { value, offset: next } = item.unpack(view, pos);
      out[i] = value;
      pos = next;
    }
    return { value: out, offset: pos };
  },
});
