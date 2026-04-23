import type { MemPackCodec } from "../MemPackCodec";
/**
 * Variable-length UTF-8 text: same layout as `bytes` (Length prefix + raw
 * bytes) but with UTF-8 validation on decode. Reference:
 * `~/code/reference/mempack/src/Data/MemPack.hs:1047-1070`.
 *
 * Text requires encoding to UTF-8 to know the byte count. We accept one
 * extra encode pass in `packedByteCount` — JS's `TextEncoder` is fast enough
 * that this is acceptable overhead vs. carrying a cache through the API.
 */
export declare const text: MemPackCodec<string>;
//# sourceMappingURL=text.d.ts.map