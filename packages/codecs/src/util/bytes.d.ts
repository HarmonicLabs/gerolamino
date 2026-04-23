/**
 * Byte-manipulation primitives shared across the monorepo.
 *
 * Scope: functions taking `Uint8Array` / `ArrayBuffer` in and out — no domain
 * types. Living in `codecs` (the foundation package) keeps every downstream
 * package on one implementation.
 */
/** Hex-encode a `Uint8Array` as a lowercase string. */
export declare const hex: (bytes: Uint8Array) => string;
/** Decode a hex string (any case) into a `Uint8Array`. */
export declare const fromHex: (s: string) => Uint8Array;
/** Concatenate multiple `Uint8Array`s into a single buffer. */
export declare const concat: (...parts: ReadonlyArray<Uint8Array>) => Uint8Array;
/** Lexicographic byte comparator (RFC 8949 §4.2.1 canonical map-key ordering). */
export declare const compareBytes: (a: Uint8Array, b: Uint8Array) => number;
/** Encode a number as big-endian 32-bit unsigned integer. */
export declare const be32: (n: number) => Uint8Array;
/** Encode a number as big-endian 64-bit unsigned integer. */
export declare const be64: (n: number) => Uint8Array;
//# sourceMappingURL=bytes.d.ts.map