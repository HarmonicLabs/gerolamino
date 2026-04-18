import type { MemPackCodec } from "../MemPackCodec";
import { MemPackEncodeError } from "../MemPackError";

/**
 * Fixed-width unsigned integer codecs. Mirror the Haskell instances at
 * `~/code/reference/mempack/src/Data/MemPack.hs:509-597` — direct
 * native-endian memory I/O via GHC primops (`writeWord8ArrayAsWord16#`, etc.).
 * No length prefix, no padding.
 *
 * Uses `DataView` directly — the native ECMAScript primitive for typed
 * little-endian reads/writes. No wrapper classes.
 *
 * Encode-side range validation mirrors `tag.ts`: `DataView.setUint*`
 * silently truncates out-of-range inputs, which would corrupt the wire.
 * Haskell's `Word{8,16,32,64}` types enforce range at the type level;
 * JS `number`/`bigint` do not, so callers get an explicit error instead.
 * Decode needs no check — `getUint*` returns values provably in range.
 */

const checkUInt = (n: number, max: number, typeName: string): void => {
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new MemPackEncodeError({
      cause: `${typeName} out of range: ${n} (must be 0..${max} integer)`,
    });
  }
};

const WORD64_MAX = 0xffffffffffffffffn;

const checkUInt64 = (n: bigint): void => {
  if (n < 0n || n > WORD64_MAX) {
    throw new MemPackEncodeError({
      cause: `Word64 out of range: ${n} (must be 0..${WORD64_MAX})`,
    });
  }
};

export const word8: MemPackCodec<number> = {
  typeName: "Word8",
  packedByteCount: () => 1,
  packInto: (n, view, offset) => {
    checkUInt(n, 0xff, "Word8");
    view.setUint8(offset, n);
    return offset + 1;
  },
  unpack: (view, offset) => ({ value: view.getUint8(offset), offset: offset + 1 }),
};

export const word16: MemPackCodec<number> = {
  typeName: "Word16",
  packedByteCount: () => 2,
  packInto: (n, view, offset) => {
    checkUInt(n, 0xffff, "Word16");
    view.setUint16(offset, n, true);
    return offset + 2;
  },
  unpack: (view, offset) => ({ value: view.getUint16(offset, true), offset: offset + 2 }),
};

export const word32: MemPackCodec<number> = {
  typeName: "Word32",
  packedByteCount: () => 4,
  packInto: (n, view, offset) => {
    checkUInt(n, 0xffffffff, "Word32");
    view.setUint32(offset, n, true);
    return offset + 4;
  },
  unpack: (view, offset) => ({ value: view.getUint32(offset, true), offset: offset + 4 }),
};

export const word64: MemPackCodec<bigint> = {
  typeName: "Word64",
  packedByteCount: () => 8,
  packInto: (n, view, offset) => {
    checkUInt64(n);
    view.setBigUint64(offset, n, true);
    return offset + 8;
  },
  unpack: (view, offset) => ({ value: view.getBigUint64(offset, true), offset: offset + 8 }),
};
