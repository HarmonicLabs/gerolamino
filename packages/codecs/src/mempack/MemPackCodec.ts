import { MemPackDecodeError, MemPackEncodeError } from "./MemPackError";

/**
 * MemPackCodec<T> — the TypeScript analog of Haskell's `MemPack` typeclass
 * (see `~/code/reference/mempack/src/Data/MemPack.hs`).
 *
 * Design choice: architecture B (function-producing) from the plan. MemPack
 * is NOT self-describing — the wire bytes carry no type info — so there's no
 * natural intermediate tree representation like CBOR's `CborValue`. Instead,
 * each codec is a triple of functions that compose via *offset advancement*
 * at composite types (tuples, structs, arrays).
 *
 * No growing buffer, no custom reader/writer class. The Haskell reference
 * allocates a pre-sized mutable byte array via `newByteArray# (packedByteCount x)`
 * and reads/writes in-place tracking position with `StateT Int`. In TypeScript
 * we do the same using only **native** primitives:
 *
 *   - `Uint8Array` for byte-level slices (top-level allocation, `bytes` codec)
 *   - `DataView` for typed multi-byte reads/writes (native-endian via the
 *     `littleEndian` flag on `setInt16` / `getFloat64` / etc.)
 *   - A plain numeric offset threaded through each codec's `packInto` / `unpack`
 *
 * Composite types simply advance the offset through their children — zero
 * intermediate allocations, zero copying.
 *
 * Endianness: native little-endian on x86-64, matching the Haskell reference
 * implementation's use of GHC primops (`writeWord8ArrayAsWord64#` etc.).
 * Deliberate MemPack design choice for zero-cost host I/O.
 */
export interface MemPackCodec<T> {
  /** Human-readable type name used in decode error messages. */
  readonly typeName: string;

  /**
   * Exact byte count of `value`'s MemPack encoding. Must be tight:
   * `packedByteCount(v) === packInto(v, view, 0) - 0`. Many operations
   * depend on this invariant for single-shot buffer allocation.
   */
  readonly packedByteCount: (value: T) => number;

  /**
   * Write `value`'s bytes into `view` starting at `offset`. The caller is
   * responsible for ensuring `view` has at least `packedByteCount(value)`
   * bytes available from `offset`. Returns the offset immediately after the
   * last byte written (i.e. `offset + packedByteCount(value)`).
   */
  readonly packInto: (value: T, view: DataView, offset: number) => number;

  /**
   * Deserialize starting at `offset` in `view`. Returns the decoded value
   * plus the offset of the next unread byte. Throws `MemPackDecodeError` on
   * malformed input (wrong tag, out-of-bounds read, invalid UTF-8, etc.).
   *
   * `view` is the native abstraction — DataView carries its own bounds
   * (via `view.byteLength`) and throws RangeError on out-of-bounds reads.
   */
  readonly unpack: (view: DataView, offset: number) => UnpackResult<T>;
}

export interface UnpackResult<T> {
  readonly value: T;
  readonly offset: number;
}

/**
 * Top-level convenience: allocate a fresh, tight `Uint8Array` of exactly the
 * right size and serialize `value` into it. Uses one allocation total — no
 * growing, no copying.
 */
export const packToUint8Array = <T>(codec: MemPackCodec<T>, value: T): Uint8Array => {
  const size = codec.packedByteCount(value);
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const final = codec.packInto(value, view, 0);
  if (final !== size) {
    throw new MemPackEncodeError({
      cause: `MemPack codec '${codec.typeName}' wrote ${final} bytes but declared ${size}`,
    });
  }
  return buf;
};

/**
 * Top-level convenience: decode `value` from `bytes`, requiring that every
 * byte is consumed (matches Haskell's `unpack`, which fails on trailing data).
 */
export const unpackFromUint8Array = <T>(codec: MemPackCodec<T>, bytes: Uint8Array): T => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { value, offset } = codec.unpack(view, 0);
  if (offset !== bytes.byteLength) {
    throw new MemPackDecodeError({
      cause: `MemPack codec '${codec.typeName}' left ${bytes.byteLength - offset} bytes unconsumed`,
    });
  }
  return value;
};
