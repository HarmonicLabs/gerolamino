import type { MemPackCodec } from "../MemPackCodec";
/**
 * `Tag` — a Word8 discriminator used by every MemPack sum type. Range 0..255.
 * One encoding (one byte), no variation. Reference:
 * `~/code/reference/mempack/src/Data/MemPack.hs:1531-1549`.
 */
export declare const tag: MemPackCodec<number>;
//# sourceMappingURL=tag.d.ts.map