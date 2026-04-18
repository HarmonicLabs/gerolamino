import type { MemPackCodec } from "../MemPackCodec";
import { MemPackEncodeError } from "../MemPackError";

/**
 * Fixed-width signed integer codecs (two's complement, native little-endian).
 * Mirror the Haskell instances at
 * `~/code/reference/mempack/src/Data/MemPack.hs:419-507`.
 *
 * Uses `DataView` directly — no wrapper classes.
 *
 * Encode-side range validation mirrors `words.ts`/`tag.ts`:
 * `DataView.setInt*` silently truncates out-of-range inputs, which would
 * corrupt the wire. Decode needs no check — `getInt*` returns values
 * provably in range.
 */

const checkInt = (n: number, min: number, max: number, typeName: string): void => {
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new MemPackEncodeError({
      cause: `${typeName} out of range: ${n} (must be ${min}..${max} integer)`,
    });
  }
};

const INT64_MIN = -0x8000000000000000n;
const INT64_MAX = 0x7fffffffffffffffn;

const checkInt64 = (n: bigint): void => {
  if (n < INT64_MIN || n > INT64_MAX) {
    throw new MemPackEncodeError({
      cause: `Int64 out of range: ${n} (must be ${INT64_MIN}..${INT64_MAX})`,
    });
  }
};

export const int8: MemPackCodec<number> = {
  typeName: "Int8",
  packedByteCount: () => 1,
  packInto: (n, view, offset) => {
    checkInt(n, -0x80, 0x7f, "Int8");
    view.setInt8(offset, n);
    return offset + 1;
  },
  unpack: (view, offset) => ({ value: view.getInt8(offset), offset: offset + 1 }),
};

export const int16: MemPackCodec<number> = {
  typeName: "Int16",
  packedByteCount: () => 2,
  packInto: (n, view, offset) => {
    checkInt(n, -0x8000, 0x7fff, "Int16");
    view.setInt16(offset, n, true);
    return offset + 2;
  },
  unpack: (view, offset) => ({ value: view.getInt16(offset, true), offset: offset + 2 }),
};

export const int32: MemPackCodec<number> = {
  typeName: "Int32",
  packedByteCount: () => 4,
  packInto: (n, view, offset) => {
    checkInt(n, -0x80000000, 0x7fffffff, "Int32");
    view.setInt32(offset, n, true);
    return offset + 4;
  },
  unpack: (view, offset) => ({ value: view.getInt32(offset, true), offset: offset + 4 }),
};

export const int64: MemPackCodec<bigint> = {
  typeName: "Int64",
  packedByteCount: () => 8,
  packInto: (n, view, offset) => {
    checkInt64(n);
    view.setBigInt64(offset, n, true);
    return offset + 8;
  },
  unpack: (view, offset) => ({ value: view.getBigInt64(offset, true), offset: offset + 8 }),
};
