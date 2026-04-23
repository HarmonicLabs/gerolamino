/**
 * Byte-manipulation primitives shared across the monorepo.
 *
 * Scope: functions taking `Uint8Array` / `ArrayBuffer` in and out — no domain
 * types. Living in `codecs` (the foundation package) keeps every downstream
 * package on one implementation.
 */

/** Hex-encode a `Uint8Array` as a lowercase string. */
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Decode a hex string (any case) into a `Uint8Array`. */
export const fromHex = (s: string): Uint8Array => {
  const n = s.length >>> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(s.substring(i * 2, i * 2 + 2), 16);
  return out;
};

/** Concatenate multiple `Uint8Array`s into a single buffer. */
export const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
};

/** Lexicographic byte comparator (RFC 8949 §4.2.1 canonical map-key ordering). */
export const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
};

/** Encode a number as big-endian 32-bit unsigned integer. */
export const be32 = (n: number): Uint8Array => {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n);
  return buf;
};

/** Encode a number as big-endian 64-bit unsigned integer. */
export const be64 = (n: number): Uint8Array => {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(n));
  return buf;
};
