import type { MemPackCodec } from "../MemPackCodec";

/**
 * Fixed-width signed integer codecs (two's complement, native little-endian).
 * Mirror the Haskell instances at
 * `~/code/reference/mempack/src/Data/MemPack.hs:419-507`.
 *
 * Uses `DataView` directly — no wrapper classes.
 */

export const int8: MemPackCodec<number> = {
  typeName: "Int8",
  packedByteCount: () => 1,
  packInto: (n, view, offset) => {
    view.setInt8(offset, n);
    return offset + 1;
  },
  unpack: (view, offset) => ({ value: view.getInt8(offset), offset: offset + 1 }),
};

export const int16: MemPackCodec<number> = {
  typeName: "Int16",
  packedByteCount: () => 2,
  packInto: (n, view, offset) => {
    view.setInt16(offset, n, true);
    return offset + 2;
  },
  unpack: (view, offset) => ({ value: view.getInt16(offset, true), offset: offset + 2 }),
};

export const int32: MemPackCodec<number> = {
  typeName: "Int32",
  packedByteCount: () => 4,
  packInto: (n, view, offset) => {
    view.setInt32(offset, n, true);
    return offset + 4;
  },
  unpack: (view, offset) => ({ value: view.getInt32(offset, true), offset: offset + 4 }),
};

export const int64: MemPackCodec<bigint> = {
  typeName: "Int64",
  packedByteCount: () => 8,
  packInto: (n, view, offset) => {
    view.setBigInt64(offset, n, true);
    return offset + 8;
  },
  unpack: (view, offset) => ({ value: view.getBigInt64(offset, true), offset: offset + 8 }),
};
