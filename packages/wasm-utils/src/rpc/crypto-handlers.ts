import { Effect } from "effect";

import {
  blake2b_256,
  check_vrf_leader,
  ed25519_verify,
  kes_sum6_verify,
  vrf_proof_to_hash,
  vrf_verify_proof,
} from "../../pkg/wasm_utils.js";

import { wrapCryptoOp } from "../errors.ts";
import { initWasm } from "../init.ts";

import { CryptoRpcGroup } from "./crypto-rpc.ts";

/**
 * Shared handler Layer for the Crypto RPC group.
 *
 * Runs raw wasm-bindgen functions on the worker thread. `initWasm` is
 * sequenced once at layer construction — Layer memoization guarantees a
 * single WASM instantiation per worker. Composed via `.pipe()` so the
 * Layer body is a single sequenced Effect, not a nested generator.
 */
export const CryptoHandlersLive = CryptoRpcGroup.toLayer(
  initWasm.pipe(
    Effect.as(
      CryptoRpcGroup.of({
        Ed25519Verify: ({ message, publicKey, signature }) =>
          wrapCryptoOp("ed25519Verify", () => ed25519_verify(message, signature, publicKey)),
        KesSum6Verify: ({ message, period, publicKey, signature }) =>
          wrapCryptoOp("kesSum6Verify", () =>
            kes_sum6_verify(signature, period, publicKey, message),
          ),
        CheckVrfLeader: ({
          activeSlotCoeffDen,
          activeSlotCoeffNum,
          sigmaDenominator,
          sigmaNumerator,
          vrfOutputHex,
        }) =>
          wrapCryptoOp("checkVrfLeader", () =>
            check_vrf_leader(
              vrfOutputHex,
              sigmaNumerator,
              sigmaDenominator,
              activeSlotCoeffNum,
              activeSlotCoeffDen,
            ),
          ),
        VrfVerifyProof: ({ vrfInput, vrfProof, vrfVkey }) =>
          wrapCryptoOp("vrfVerifyProof", () => vrf_verify_proof(vrfVkey, vrfProof, vrfInput)),
        VrfProofToHash: ({ vrfProof }) =>
          wrapCryptoOp("vrfProofToHash", () => vrf_proof_to_hash(vrfProof)),
        Blake2b256: ({ data }) => wrapCryptoOp("blake2b256", () => blake2b_256(data)),
      }),
    ),
  ),
);
