import type { MemPackCodec } from "../MemPackCodec";
/**
 * Variable-length byte string: `Length` prefix + raw bytes.
 * Reference: `~/code/reference/mempack/src/Data/MemPack.hs:942-1007`
 * (the `ByteArray`, `PrimArray Word8`, `ShortByteString`, and `ByteString`
 * instances all share this layout).
 *
 * Uses native `Uint8Array` + `DataView` directly. Byte slices are zero-copy
 * views over the underlying ArrayBuffer (not Array.from copies).
 */
export declare const bytes: MemPackCodec<Uint8Array>;
//# sourceMappingURL=bytes.d.ts.map