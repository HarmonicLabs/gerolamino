import { Effect } from "effect";

import {
  blake2b_256,
  check_vrf_leader,
  ed25519_verify,
  kes_sum6_verify,
  vrf_proof_to_hash,
  vrf_verify_proof,
} from "../../pkg/wasm_utils.js";

import { fromWasmError } from "../errors.ts";
import { initWasm } from "../init.ts";

import { CryptoRpcGroup } from "./crypto-rpc.ts";

/**
 * Shared handler Layer for the Crypto RPC group.
 *
 * Runs raw wasm-bindgen functions on the worker thread. `initWasm` is
 * yielded once at layer construction — Layer memoization guarantees a
 * single WASM instantiation per worker.
 */
export const CryptoHandlersLive = CryptoRpcGroup.toLayer(
  Effect.gen(function* () {
    yield* initWasm;
    return CryptoRpcGroup.of({
      Ed25519Verify: ({ message, publicKey, signature }) =>
        Effect.try({
          try: () => ed25519_verify(message, signature, publicKey),
          catch: (err) => fromWasmError("ed25519Verify", err),
        }),
      KesSum6Verify: ({ message, period, publicKey, signature }) =>
        Effect.try({
          try: () => kes_sum6_verify(signature, period, publicKey, message),
          catch: (err) => fromWasmError("kesSum6Verify", err),
        }),
      CheckVrfLeader: ({
        activeSlotCoeffDen,
        activeSlotCoeffNum,
        sigmaDenominator,
        sigmaNumerator,
        vrfOutputHex,
      }) =>
        Effect.try({
          try: () =>
            check_vrf_leader(
              vrfOutputHex,
              sigmaNumerator,
              sigmaDenominator,
              activeSlotCoeffNum,
              activeSlotCoeffDen,
            ),
          catch: (err) => fromWasmError("checkVrfLeader", err),
        }),
      VrfVerifyProof: ({ vrfInput, vrfProof, vrfVkey }) =>
        Effect.try({
          try: () => vrf_verify_proof(vrfVkey, vrfProof, vrfInput),
          catch: (err) => fromWasmError("vrfVerifyProof", err),
        }),
      VrfProofToHash: ({ vrfProof }) =>
        Effect.try({
          try: () => vrf_proof_to_hash(vrfProof),
          catch: (err) => fromWasmError("vrfProofToHash", err),
        }),
      Blake2b256: ({ data }) =>
        Effect.try({
          try: () => blake2b_256(data),
          catch: (err) => fromWasmError("blake2b256", err),
        }),
    });
  }),
);
