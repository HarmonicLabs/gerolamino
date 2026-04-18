import type { MemPackCodec } from "../MemPackCodec";
import { MemPackDecodeError, MemPackEncodeError } from "../MemPackError";

/**
 * VarLen — big-endian 7-bit continuation encoding for bounded unsigned
 * integers. Each byte encodes 7 data bits + 1 MSB continuation flag; the
 * **high-order** 7 bits come **first** (NOT LEB128 — LEB128 is little-endian).
 *
 * Canonical by construction: exactly one byte sequence per value (no padding
 * bits permitted). Reference:
 * `~/code/reference/mempack/src/Data/MemPack.hs:1341-1417`
 * (`packIntoCont7` + `unpack7BitVarLen`).
 *
 * Encode algorithm (from Haskell `packIntoCont7`):
 *   numBits = packedByteCount(v) * 7
 *   for n = numBits-7 step -7 down to 7:
 *     emit ((v >> n) & 0xFF) | 0x80         -- high bit set (continuation)
 *   emit v & 0x7F                            -- final byte, no continuation
 *
 * Decode algorithm (from Haskell `unpack7BitVarLen`):
 *   acc = 0
 *   loop:
 *     b = read byte
 *     if b & 0x80: acc = (acc << 7) | (b & 0x7F); continue
 *     else: acc = (acc << 7) | b; done
 *
 * TS stores values as bigint to avoid the 53-bit Number limit.
 */

const varLenByteCount = (value: bigint, typeName = "VarLen"): number => {
  if (value < 0n) {
    throw new MemPackEncodeError({
      cause: `${typeName} requires non-negative value, got ${value}`,
    });
  }
  if (value === 0n) return 1;
  // ceil(bits / 7). value.toString(2) returns the binary representation
  // without leading zeros, so its length is `finiteBitSize - countLeadingZeros`.
  const bits = value.toString(2).length;
  return Math.ceil(bits / 7);
};

const packVarLenInto = (
  value: bigint,
  view: DataView,
  offset: number,
  typeName = "VarLen",
): number => {
  const byteCount = varLenByteCount(value, typeName);
  let pos = offset;
  // Emit high-order 7-bit groups first, each with continuation bit set.
  // n counts down from (byteCount - 1) * 7 ... to 7, stepping by -7.
  for (let n = (byteCount - 1) * 7; n > 0; n -= 7) {
    const byte = Number((value >> BigInt(n)) & 0xffn) | 0x80;
    view.setUint8(pos, byte);
    pos += 1;
  }
  // Final byte: low 7 bits, continuation clear.
  view.setUint8(pos, Number(value & 0x7fn));
  return pos + 1;
};

const unpackVarLen = (view: DataView, offset: number): { value: bigint; offset: number } => {
  let acc = 0n;
  let pos = offset;
  while (true) {
    if (pos >= view.byteLength) {
      throw new MemPackDecodeError({ cause: `VarLen: ran out of bytes at offset ${pos}` });
    }
    const byte = view.getUint8(pos);
    pos += 1;
    if ((byte & 0x80) !== 0) {
      // Continuation byte — append low 7 bits.
      acc = (acc << 7n) | BigInt(byte & 0x7f);
    } else {
      // Final byte — append all 8 bits (high bit is already 0 since it's the
      // clear-continuation signal; Haskell's decoder uses the raw byte here
      // rather than masking, matching `(acc `shiftL` 7) .|. fromIntegral b8`).
      acc = (acc << 7n) | BigInt(byte);
      return { value: acc, offset: pos };
    }
  }
};

/** VarLen-encoded bigint (supports up to Word64 range in practice). */
export const varLen: MemPackCodec<bigint> = {
  typeName: "VarLen",
  packedByteCount: varLenByteCount,
  packInto: packVarLenInto,
  unpack: unpackVarLen,
};

/** Convenience: VarLen wrapper for values fitting in a JS number. */
export const varLenNumber: MemPackCodec<number> = {
  typeName: "VarLen(number)",
  packedByteCount: (n) => varLenByteCount(BigInt(n)),
  packInto: (n, view, offset) => packVarLenInto(BigInt(n), view, offset),
  unpack: (view, offset) => {
    const { value, offset: next } = unpackVarLen(view, offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new MemPackDecodeError({
        cause: `VarLen value ${value} exceeds JS safe integer range`,
      });
    }
    return { value: Number(value), offset: next };
  },
};

/**
 * `Length` — MemPack's length prefix for lists and variable-length data.
 * A VarLen Word with a sign-bit guard on decode: the high bit of the
 * underlying Word being set indicates the value would be negative when
 * reinterpreted as `Int`, which Haskell rejects (see the `MemPack Length`
 * instance in the reference). We mirror that guard here against JS's safe
 * integer limit.
 */
export const length: MemPackCodec<number> = {
  typeName: "Length",
  packedByteCount: (n) => varLenByteCount(BigInt(n), "Length"),
  packInto: (n, view, offset) => packVarLenInto(BigInt(n), view, offset, "Length"),
  unpack: (view, offset) => {
    const { value, offset: next } = unpackVarLen(view, offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new MemPackDecodeError({ cause: `Length ${value} exceeds JS safe integer range` });
    }
    return { value: Number(value), offset: next };
  },
};
