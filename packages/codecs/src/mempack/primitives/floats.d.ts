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
export declare const float32: MemPackCodec<number>;
export declare const float64: MemPackCodec<number>;
//# sourceMappingURL=floats.d.ts.map