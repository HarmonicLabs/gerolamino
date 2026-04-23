import type { MemPackCodec } from "../MemPackCodec";
/**
 * Bool is encoded as a 1-byte Tag: 0x00 = False, 0x01 = True.
 * Any other byte is rejected. Mirrors Haskell instance at
 * `~/code/reference/mempack/src/Data/MemPack.hs:275-285`.
 */
export declare const bool: MemPackCodec<boolean>;
//# sourceMappingURL=bool.d.ts.map