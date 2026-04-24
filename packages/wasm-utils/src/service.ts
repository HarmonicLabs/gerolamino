import { Context, Effect, Layer } from "effect";

import {
  blake2b_256,
  check_vrf_leader,
  ed25519_verify,
  kes_sum6_verify,
  vrf_proof_to_hash,
  vrf_verify_proof,
} from "../pkg/wasm_utils.js";

import { CryptoOpError, type CryptoOperation, fromWasmError } from "./errors.ts";
import { initWasm } from "./init.ts";

/**
 * Platform-agnostic crypto primitives backed by wasm-utils.
 *
 * All methods return `Effect.Effect<_, CryptoOpError>`; the typed error
 * captures the Rust-side `CryptoError` kind (BadLength / InvalidKey /
 * InvalidSig / InvalidProof / VerifyFailed / Parse / Address / Unknown).
 */
export class Crypto extends Context.Service<
  Crypto,
  {
    readonly blake2b256: (data: Uint8Array) => Effect.Effect<Uint8Array, CryptoOpError>;
    readonly ed25519Verify: (
      message: Uint8Array,
      signature: Uint8Array,
      publicKey: Uint8Array,
    ) => Effect.Effect<boolean, CryptoOpError>;
    readonly kesSum6Verify: (
      signature: Uint8Array,
      period: number,
      publicKey: Uint8Array,
      message: Uint8Array,
    ) => Effect.Effect<boolean, CryptoOpError>;
    readonly checkVrfLeader: (
      vrfOutputHex: string,
      sigmaNumerator: string,
      sigmaDenominator: string,
      activeSlotCoeffNum: string,
      activeSlotCoeffDen: string,
    ) => Effect.Effect<boolean, CryptoOpError>;
    readonly vrfVerifyProof: (
      vrfVkey: Uint8Array,
      vrfProof: Uint8Array,
      vrfInput: Uint8Array,
    ) => Effect.Effect<Uint8Array, CryptoOpError>;
    readonly vrfProofToHash: (vrfProof: Uint8Array) => Effect.Effect<Uint8Array, CryptoOpError>;
  }
>()("wasm-utils/Crypto") {}

/**
 * Direct in-process Crypto layer — synchronous WASM calls on the caller's
 * thread. Used by tests, unit benches, and any hot path where worker
 * round-trip overhead is unacceptable.
 */
export const CryptoDirect: Layer.Layer<Crypto> = Layer.effect(
  Crypto,
  Effect.gen(function* () {
    yield* initWasm;

    const wrap = <A>(operation: CryptoOperation, tryFn: () => A): Effect.Effect<A, CryptoOpError> =>
      Effect.try({
        try: tryFn,
        catch: (err) => fromWasmError(operation, err),
      });

    return {
      // Goes through the pallas-crypto / blake2b_simd Rust implementation in
      // WASM so shared `packages/consensus` + `packages/storage` code that
      // binds to `Crypto` is browser-compatible. `Bun.CryptoHasher` is not
      // available in the browser and must not appear in shared-package source.
      blake2b256: (data) => wrap("blake2b256", () => blake2b_256(data)),
      ed25519Verify: (message, signature, publicKey) =>
        wrap("ed25519Verify", () => ed25519_verify(message, signature, publicKey)),
      kesSum6Verify: (signature, period, publicKey, message) =>
        wrap("kesSum6Verify", () => kes_sum6_verify(signature, period, publicKey, message)),
      checkVrfLeader: (
        vrfOutputHex,
        sigmaNumerator,
        sigmaDenominator,
        activeSlotCoeffNum,
        activeSlotCoeffDen,
      ) =>
        wrap("checkVrfLeader", () =>
          check_vrf_leader(
            vrfOutputHex,
            sigmaNumerator,
            sigmaDenominator,
            activeSlotCoeffNum,
            activeSlotCoeffDen,
          ),
        ),
      vrfVerifyProof: (vrfVkey, vrfProof, vrfInput) =>
        wrap("vrfVerifyProof", () => vrf_verify_proof(vrfVkey, vrfProof, vrfInput)),
      vrfProofToHash: (vrfProof) => wrap("vrfProofToHash", () => vrf_proof_to_hash(vrfProof)),
    };
  }),
);
