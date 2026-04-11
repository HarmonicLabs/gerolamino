/**
 * Crypto service — wraps crypto primitives for consensus.
 *
 * blake2b256: Bun.CryptoHasher (native, fast)
 * ed25519/KES/VRF: wasm-utils WASM (no Bun-native equivalent)
 *
 * Three layers available:
 * - CryptoServiceBunNative: stubs for testing (no WASM)
 * - CryptoServiceLive: main-thread WASM (no workers, for tests)
 * - CryptoServiceWorker: dispatches to CryptoWorkerPool (true OS-thread parallelism)
 */
import { Effect, Layer, ServiceMap } from "effect";
import init, {
  ed25519_verify,
  kes_sum6_verify,
  check_vrf_leader,
  vrf_verify_proof,
  vrf_proof_to_hash,
} from "wasm-utils";
import { CryptoWorkerPool } from "./crypto-pool.ts";
import { CryptoRequestKind, CryptoResponseKind } from "./crypto-protocol.ts";

export class CryptoService extends ServiceMap.Service<
  CryptoService,
  {
    readonly blake2b256: (data: Uint8Array) => Uint8Array;
    readonly ed25519Verify: (
      message: Uint8Array,
      signature: Uint8Array,
      publicKey: Uint8Array,
    ) => boolean;
    readonly kesSum6Verify: (
      signature: Uint8Array,
      period: number,
      publicKey: Uint8Array,
      message: Uint8Array,
    ) => boolean;
    readonly checkVrfLeader: (
      vrfOutputHex: string,
      sigmaNumerator: string,
      sigmaDenominator: string,
      activeSlotCoeffNum: string,
      activeSlotCoeffDen: string,
    ) => boolean;
    /** Verify a VRF proof (ECVRF-ED25519-SHA512-Elligator2). Returns 64-byte proof hash. */
    readonly vrfVerifyProof: (
      vrfVkey: Uint8Array,
      vrfProof: Uint8Array,
      vrfInput: Uint8Array,
    ) => Uint8Array;
    /** Compute VRF proof-to-hash without verifying. Returns 64-byte hash. */
    readonly vrfProofToHash: (vrfProof: Uint8Array) => Uint8Array;
  }
>()("consensus/CryptoService") {}

const bunBlake2b256 = (data: Uint8Array): Uint8Array => {
  const hasher = new Bun.CryptoHasher("blake2b256");
  return new Uint8Array(hasher.update(data).digest().buffer);
};

/**
 * Test-only crypto layer. blake2b256 is real (Bun native).
 * Ed25519, KES, and VRF are stubs that always pass.
 */
export const CryptoServiceBunNative = {
  blake2b256: bunBlake2b256,
  ed25519Verify: (_message: Uint8Array, _signature: Uint8Array, _publicKey: Uint8Array): boolean =>
    true,
  kesSum6Verify: (_sig: Uint8Array, _period: number, _pk: Uint8Array, _msg: Uint8Array): boolean =>
    true,
  checkVrfLeader: (_v: string, _sn: string, _sd: string, _cn: string, _cd: string): boolean => true,
  vrfVerifyProof: (_vkey: Uint8Array, _proof: Uint8Array, _input: Uint8Array): Uint8Array =>
    new Uint8Array(64),
  vrfProofToHash: (_proof: Uint8Array): Uint8Array => new Uint8Array(64),
};

/**
 * Production crypto layer.
 * blake2b256: Bun.CryptoHasher (native)
 * ed25519/KES/VRF: wasm-utils WASM
 */
export const CryptoServiceLive: Layer.Layer<CryptoService> = Layer.effect(
  CryptoService,
  Effect.gen(function* () {
    // wasm-bindgen's default export auto-locates wasm_utils_bg.wasm via import.meta.url
    yield* Effect.promise(() => init());

    return {
      blake2b256: bunBlake2b256,
      ed25519Verify: (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean =>
        ed25519_verify(message, signature, publicKey),
      kesSum6Verify: (
        signature: Uint8Array,
        period: number,
        publicKey: Uint8Array,
        message: Uint8Array,
      ): boolean => kes_sum6_verify(signature, period, publicKey, message),
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
      vrfVerifyProof: (
        vrfVkey: Uint8Array,
        vrfProof: Uint8Array,
        vrfInput: Uint8Array,
      ): Uint8Array => vrf_verify_proof(vrfVkey, vrfProof, vrfInput),
      vrfProofToHash: (vrfProof: Uint8Array): Uint8Array => vrf_proof_to_hash(vrfProof),
    };
  }),
);

// CryptoWorkerPool re-export for convenience — the actual pool layer is in
// crypto-pool.ts. Worker-backed crypto dispatch happens in chain-sync-driver.ts
// (Phase 3) where validateHeader forks assertions to the pool.
