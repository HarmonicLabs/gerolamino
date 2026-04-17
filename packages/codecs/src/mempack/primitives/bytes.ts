import type { MemPackCodec } from "../MemPackCodec";
import { MemPackDecodeError } from "../MemPackError";
import { length } from "./varlen";

/**
 * Variable-length byte string: `Length` prefix + raw bytes.
 * Reference: `~/code/reference/mempack/src/Data/MemPack.hs:942-1007`
 * (the `ByteArray`, `PrimArray Word8`, `ShortByteString`, and `ByteString`
 * instances all share this layout).
 *
 * Uses native `Uint8Array` + `DataView` directly. Byte slices are zero-copy
 * views over the underlying ArrayBuffer (not Array.from copies).
 */
export const bytes: MemPackCodec<Uint8Array> = {
  typeName: "Bytes",
  packedByteCount: (b) => length.packedByteCount(b.byteLength) + b.byteLength,
  packInto: (b, view, offset) => {
    const afterLen = length.packInto(b.byteLength, view, offset);
    new Uint8Array(view.buffer, view.byteOffset + afterLen, b.byteLength).set(b);
    return afterLen + b.byteLength;
  },
  unpack: (view, offset) => {
    const { value: n, offset: afterLen } = length.unpack(view, offset);
    if (afterLen + n > view.byteLength) {
      throw new MemPackDecodeError({
        cause: `Bytes: requested ${n} bytes at offset ${afterLen}, only ${view.byteLength - afterLen} available`,
      });
    }
    const slice = new Uint8Array(view.buffer, view.byteOffset + afterLen, n);
    return { value: slice, offset: afterLen + n };
  },
};
