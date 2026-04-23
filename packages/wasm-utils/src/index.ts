/**
 * wasm-utils barrel — platform-agnostic Cardano crypto primitives.
 *
 * Preferred API: the `Crypto` service + `CryptoDirect` layer.
 * Raw wasm-bindgen functions are re-exported for back-compat with legacy
 * consumers; new code should go through the service.
 */

import init from "../pkg/wasm_utils.js";

export * from "./errors.ts";
export * from "./init.ts";
export * from "./rpc/index.ts";
export * from "./service.ts";

export { init };
export default init;
export {
  address_from_bech32,
  address_from_hex,
  address_has_script,
  address_network,
  address_to_bech32,
  address_to_hex,
  address_type_id,
  blake2b_256,
  check_vrf_leader,
  CryptoError,
  derive_epoch_nonce,
  ed25519_extended_public_key,
  ed25519_extended_sign,
  ed25519_public_key,
  ed25519_secret_key_from_seed,
  ed25519_sign,
  ed25519_verify,
  evolve_nonce,
  initSync,
  kes_sum6_verify,
  vrf_derive_input,
  vrf_leader_tag,
  vrf_nonce_tag,
  vrf_proof_to_hash,
  vrf_verify_proof,
} from "../pkg/wasm_utils.js";
