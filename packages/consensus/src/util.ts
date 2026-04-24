/**
 * Byte utilities for consensus — re-exports from the codecs foundation package
 * to keep the monorepo on a single implementation.
 *
 * Hex encoding/decoding is NOT re-exported: call `bytes.toHex()` and
 * `Uint8Array.fromHex(s)` (ES2025 natives) directly at the use site.
 */
export { concat, compareBytes, be32, be64 } from "codecs";
