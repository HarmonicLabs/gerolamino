import type { MemPackCodec } from "../MemPackCodec";

/**
 * Fixed-width unsigned integer codecs. Mirror the Haskell instances at
 * `~/code/reference/mempack/src/Data/MemPack.hs:509-597` — direct
 * native-endian memory I/O via GHC primops (`writeWord8ArrayAsWord16#`, etc.).
 * No length prefix, no padding.
 *
 * Uses `DataView` directly — the native ECMAScript primitive for typed
 * little-endian reads/writes. No wrapper classes.
 */

export const word8: MemPackCodec<number> = {
  typeName: "Word8",
  packedByteCount: () => 1,
  packInto: (n, view, offset) => {
    view.setUint8(offset, n);
    return offset + 1;
  },
  unpack: (view, offset) => ({ value: view.getUint8(offset), offset: offset + 1 }),
};

export const word16: MemPackCodec<number> = {
  typeName: "Word16",
  packedByteCount: () => 2,
  packInto: (n, view, offset) => {
    view.setUint16(offset, n, true);
    return offset + 2;
  },
  unpack: (view, offset) => ({ value: view.getUint16(offset, true), offset: offset + 2 }),
};

export const word32: MemPackCodec<number> = {
  typeName: "Word32",
  packedByteCount: () => 4,
  packInto: (n, view, offset) => {
    view.setUint32(offset, n, true);
    return offset + 4;
  },
  unpack: (view, offset) => ({ value: view.getUint32(offset, true), offset: offset + 4 }),
};

export const word64: MemPackCodec<bigint> = {
  typeName: "Word64",
  packedByteCount: () => 8,
  packInto: (n, view, offset) => {
    view.setBigUint64(offset, n, true);
    return offset + 8;
  },
  unpack: (view, offset) => ({ value: view.getBigUint64(offset, true), offset: offset + 8 }),
};
