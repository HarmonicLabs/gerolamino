/**
 * Shared byte utilities for consensus package.
 */

/** Hex-encode a Uint8Array. */
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Concatenate multiple Uint8Arrays. */
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
