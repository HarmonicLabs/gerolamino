import type { MemPackCodec } from "../MemPackCodec";

/**
 * IEEE 754 float codecs (native little-endian). Mirror the Haskell
 * `Float` / `Double` instances at
 * `~/code/reference/mempack/src/Data/MemPack.hs:763-786`.
 *
 * Uses `DataView.setFloat32` / `setFloat64` with `littleEndian: true` to
 * match the GHC primops `writeWord8ArrayAsFloat#` / `writeWord8ArrayAsDouble#`.
 *
 * ES2025 half-precision support is available (`DataView.setFloat16`) but the
 * Haskell reference does not define a MemPack instance for `Half` — we skip
 * it here until a concrete need arises.
 */

export const float32: MemPackCodec<number> = {
  typeName: "Float",
  packedByteCount: () => 4,
  packInto: (n, view, offset) => {
    view.setFloat32(offset, n, true);
    return offset + 4;
  },
  unpack: (view, offset) => ({
    value: view.getFloat32(offset, true),
    offset: offset + 4,
  }),
};

export const float64: MemPackCodec<number> = {
  typeName: "Double",
  packedByteCount: () => 8,
  packInto: (n, view, offset) => {
    view.setFloat64(offset, n, true);
    return offset + 8;
  },
  unpack: (view, offset) => ({
    value: view.getFloat64(offset, true),
    offset: offset + 8,
  }),
};
