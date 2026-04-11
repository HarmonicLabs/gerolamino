/**
 * Hash utility functions — pure operations on hash byte arrays.
 *
 * These work with the existing Uint8Array-based hash types (Hash28, Hash32, etc.)
 * without requiring Schema.Class wrappers.
 */

/** Convert hash bytes to hex string. */
export function hashToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

/** Convert hex string to hash bytes. */
export function hexToHash(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Compare two hashes for equality. */
export function hashEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Compare two hashes lexicographically (for sorting). */
export function hashCompare(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  if (a.length < b.length) return -1;
  if (a.length > b.length) return 1;
  return 0;
}

/** Validate a hex string is a valid hash of the given byte length. */
export function isValidHashHex(hex: string, byteLength: number): boolean {
  return hex.length === byteLength * 2 && /^[0-9a-f]+$/i.test(hex);
}

/** Convert ASCII string to bytes. */
export function fromAscii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Convert bytes to ASCII string. */
export function toAscii(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
