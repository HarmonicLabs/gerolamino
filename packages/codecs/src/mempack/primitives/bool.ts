import type { MemPackCodec } from "../MemPackCodec";
import { MemPackDecodeError } from "../MemPackError";

/**
 * Bool is encoded as a 1-byte Tag: 0x00 = False, 0x01 = True.
 * Any other byte is rejected. Mirrors Haskell instance at
 * `~/code/reference/mempack/src/Data/MemPack.hs:275-285`.
 */
export const bool: MemPackCodec<boolean> = {
  typeName: "Bool",
  packedByteCount: () => 1,
  packInto: (b, view, offset) => {
    view.setUint8(offset, b ? 1 : 0);
    return offset + 1;
  },
  unpack: (view, offset) => {
    const tag = view.getUint8(offset);
    if (tag !== 0 && tag !== 1) {
      throw new MemPackDecodeError({
        cause: `Expected Bool tag 0x00 or 0x01, got ${tag}`,
      });
    }
    return { value: tag === 1, offset: offset + 1 };
  },
};
