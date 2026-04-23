/**
 * Byte utilities for consensus — re-exports from the codecs foundation package
 * to keep the monorepo on a single implementation.
 */
export { hex, fromHex, concat, compareBytes, be32, be64 } from "codecs";
