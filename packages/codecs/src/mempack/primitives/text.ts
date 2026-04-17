import type { MemPackCodec } from "../MemPackCodec";
import { MemPackDecodeError } from "../MemPackError";
import { bytes } from "./bytes";
import { length } from "./varlen";

/**
 * Module-level singletons — allocated once at module load, shared across all
 * `text` pack/unpack invocations. `TextEncoder` / `TextDecoder` are designed
 * for reuse; re-allocating per call is pure overhead.
 *
 * The decoder is constructed with `{ fatal: true }` so malformed UTF-8
 * surfaces as a thrown `TypeError` instead of silent U+FFFD substitution —
 * caught in `unpack` below and re-thrown as `MemPackDecodeError`.
 */
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Variable-length UTF-8 text: same layout as `bytes` (Length prefix + raw
 * bytes) but with UTF-8 validation on decode. Reference:
 * `~/code/reference/mempack/src/Data/MemPack.hs:1047-1070`.
 *
 * Text requires encoding to UTF-8 to know the byte count. We accept one
 * extra encode pass in `packedByteCount` — JS's `TextEncoder` is fast enough
 * that this is acceptable overhead vs. carrying a cache through the API.
 */
export const text: MemPackCodec<string> = {
  typeName: "Text",
  packedByteCount: (s) => bytes.packedByteCount(TEXT_ENCODER.encode(s)),
  packInto: (s, view, offset) => {
    const utf8 = TEXT_ENCODER.encode(s);
    const afterLen = length.packInto(utf8.byteLength, view, offset);
    new Uint8Array(view.buffer, view.byteOffset + afterLen, utf8.byteLength).set(utf8);
    return afterLen + utf8.byteLength;
  },
  unpack: (view, offset) => {
    const { value: slice, offset: next } = bytes.unpack(view, offset);
    try {
      return { value: TEXT_DECODER.decode(slice), offset: next };
    } catch (cause) {
      throw new MemPackDecodeError({ cause: `Invalid UTF-8 while decoding Text: ${cause}` });
    }
  },
};
