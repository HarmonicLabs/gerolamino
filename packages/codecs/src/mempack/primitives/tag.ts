import type { MemPackCodec } from "../MemPackCodec";
import { MemPackEncodeError } from "../MemPackError";

/**
 * `Tag` — a Word8 discriminator used by every MemPack sum type. Range 0..255.
 * One encoding (one byte), no variation. Reference:
 * `~/code/reference/mempack/src/Data/MemPack.hs:1531-1549`.
 */
export const tag: MemPackCodec<number> = {
  typeName: "Tag",
  packedByteCount: () => 1,
  packInto: (n, view, offset) => {
    if (n < 0 || n > 0xff || !Number.isInteger(n)) {
      throw new MemPackEncodeError({
        cause: `Tag out of range: ${n} (must be 0..255 integer)`,
      });
    }
    view.setUint8(offset, n);
    return offset + 1;
  },
  unpack: (view, offset) => ({ value: view.getUint8(offset), offset: offset + 1 }),
};
