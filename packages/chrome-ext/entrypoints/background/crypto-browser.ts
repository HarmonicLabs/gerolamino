/**
 * Browser CryptoService — uses wasm-utils WASM bindings directly.
 *
 * wasm-utils is compiled with wasm-bindgen target=web, which provides
 * a browser-compatible init() that loads WASM via fetch + import.meta.url.
 * The MV3 manifest includes 'wasm-unsafe-eval' CSP for this.
 */
import { Effect, Layer } from "effect";
import { CryptoService } from "consensus";
import init, { blake2b_256, ed25519_verify, kes_sum6_verify } from "wasm-utils";

/** Initialize WASM once — cached after first call. */
export const initWasm = Effect.promise(() => init());

/**
 * Browser CryptoService backed by wasm-utils.
 *
 * All crypto operations use the same WASM module:
 * - blake2b256: pallas_crypto blake2b
 * - ed25519Verify: pallas_crypto ed25519
 * - kesSum6Verify: pallas_crypto KES Sum6
 * - vrfVerifyProof: stub (genesis sync only — Byron blocks skip VRF)
 * - vrfProofToHash: stub (genesis sync only)
 * - checkVrfLeader: stub (genesis sync only)
 */
export const CryptoServiceBrowser: Layer.Layer<CryptoService> = Layer.effect(
  CryptoService,
  Effect.gen(function* () {
    // Ensure WASM is initialized before creating the service
    yield* initWasm;

    return {
      blake2b256: (data: Uint8Array): Uint8Array => blake2b_256(data),

      ed25519Verify: (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean =>
        ed25519_verify(message, signature, publicKey),

      kesSum6Verify: (
        signature: Uint8Array,
        period: number,
        publicKey: Uint8Array,
        message: Uint8Array,
      ): boolean => kes_sum6_verify(signature, period, publicKey, message),

      // VRF and leader check are only needed for Shelley+ with pool keys.
      // During genesis sync (Byron), these are never called (poolVrfKeys is empty).
      // Stubs return sentinel values: all-zeros (skipped by validate-header) or false.
      // TODO: Wire VRF WASM (libsodium-vrf) for full Shelley+ validation in browser.
      vrfVerifyProof: (
        _vrfVkey: Uint8Array,
        _vrfProof: Uint8Array,
        _vrfInput: Uint8Array,
      ): Uint8Array => new Uint8Array(64),

      vrfProofToHash: (_vrfProof: Uint8Array): Uint8Array => new Uint8Array(32),

      checkVrfLeader: (
        _vrfOutputHex: string,
        _sigmaNumerator: string,
        _sigmaDenominator: string,
        _activeSlotCoeffNum: string,
        _activeSlotCoeffDen: string,
      ): boolean => false,
    };
  }),
);
