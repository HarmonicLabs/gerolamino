/**
 * Browser CryptoService — uses wasm-utils WASM bindings directly.
 *
 * wasm-utils is compiled with wasm-bindgen target=web, which provides
 * a browser-compatible init() that loads WASM via fetch + import.meta.url.
 * The MV3 manifest includes 'wasm-unsafe-eval' CSP for this.
 */
import { Effect, Layer } from "effect";
import { CryptoService } from "consensus";
import init, {
  blake2b_256,
  ed25519_verify,
  kes_sum6_verify,
  check_vrf_leader,
  vrf_verify_proof,
  vrf_proof_to_hash,
} from "wasm-utils";

/** Initialize WASM once — cached after first call. wasm-plexer is eagerly loaded by the bundler. */
export const initWasm = Effect.gen(function* () {
  yield* Effect.log("[crypto] Loading wasm-utils module (blake2b/ed25519/KES)...");
  yield* Effect.promise(() => init());
  yield* Effect.log("[crypto] wasm-utils loaded");
});

/**
 * Browser CryptoService backed by wasm-utils.
 *
 * All crypto operations use the same WASM module:
 * - blake2b256: pallas_crypto blake2b
 * - ed25519Verify: pallas_crypto ed25519
 * - kesSum6Verify: pallas_crypto KES Sum6
 * - vrfVerifyProof: amaru-vrf-dalek ECVRF-ED25519-SHA512-Elligator2
 * - vrfProofToHash: amaru-vrf-dalek proof → 64-byte hash
 * - checkVrfLeader: pallas-math FixedDecimal exp_cmp threshold check
 */
export const CryptoServiceBrowser: Layer.Layer<CryptoService> = Layer.effect(
  CryptoService,
  Effect.gen(function* () {
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

      vrfVerifyProof: (
        vrfVkey: Uint8Array,
        vrfProof: Uint8Array,
        vrfInput: Uint8Array,
      ): Uint8Array => vrf_verify_proof(vrfVkey, vrfProof, vrfInput),

      vrfProofToHash: (vrfProof: Uint8Array): Uint8Array => vrf_proof_to_hash(vrfProof),

      checkVrfLeader: (
        vrfOutputHex: string,
        sigmaNumerator: string,
        sigmaDenominator: string,
        activeSlotCoeffNum: string,
        activeSlotCoeffDen: string,
      ): boolean =>
        check_vrf_leader(
          vrfOutputHex,
          sigmaNumerator,
          sigmaDenominator,
          activeSlotCoeffNum,
          activeSlotCoeffDen,
        ),
    };
  }),
);
