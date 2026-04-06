/**
 * Crypto service — wraps WASM crypto primitives for consensus.
 *
 * Provides blake2b, ed25519, and KES verification via wasm-utils.
 * Used by header validation assertions.
 */
import { Effect, ServiceMap } from "effect";

export class CryptoService extends ServiceMap.Service<
  CryptoService,
  {
    readonly blake2b256: (data: Uint8Array) => Uint8Array;
    readonly ed25519Verify: (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => boolean;
    readonly kesSum6Verify: (
      signature: Uint8Array,
      period: number,
      publicKey: Uint8Array,
      message: Uint8Array,
    ) => boolean;
  }
>()("consensus/CryptoService") {}

/**
 * Bun-native crypto layer using Bun.CryptoHasher.
 * Fallback when wasm-utils isn't loaded (e.g., in tests).
 * Ed25519 and KES are stubs — real implementation needs wasm-utils.
 */
export const CryptoServiceBunNative = {
  blake2b256: (data: Uint8Array): Uint8Array => {
    const hasher = new Bun.CryptoHasher("blake2b256");
    return new Uint8Array(hasher.update(data).digest().buffer);
  },
  ed25519Verify: (_message: Uint8Array, _signature: Uint8Array, _publicKey: Uint8Array): boolean => {
    // TODO: use wasm-utils ed25519_verify once loaded
    return true;
  },
  kesSum6Verify: (
    _signature: Uint8Array,
    _period: number,
    _publicKey: Uint8Array,
    _message: Uint8Array,
  ): boolean => {
    // TODO: use wasm-utils kes_sum6_verify once loaded
    return true;
  },
};
