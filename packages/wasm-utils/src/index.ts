/**
 * wasm-utils barrel — platform-agnostic Cardano crypto primitives.
 *
 * Preferred API: the `Crypto` service + `CryptoDirect` layer.
 * Raw wasm-bindgen functions are re-exported for back-compat with legacy
 * consumers; new code should go through the service.
 */

import init from "../pkg/wasm_utils.js";

// Named re-exports rather than `export * from "./X.ts"` — tsgo's
// cross-package re-export resolution silently drops `export *`
// chains, leaving downstream packages unable to see `Crypto`,
// `CryptoOpError`, `WasmBytes`, etc. through the barrel even though
// Rolldown bundles them correctly at runtime. Explicit named
// re-exports survive the cross-package boundary. Keep this list in
// sync with the source files' exports — adding a new symbol there
// also requires adding it here.
export {
  CryptoErrorKind,
  CryptoOperation,
  CryptoOpError,
  fromWasmError,
  wrapCryptoOp,
} from "./errors.ts";
export { initWasm } from "./init.ts";
export {
  WasmBytes,
  WasmBytesFsLayer,
  WasmBytesUrlLayer,
  WasmLoadError,
} from "./loader.ts";
export { lsmTreeJsffiUrl, lsmTreeWasmUrl } from "./lsm-shim/urls.ts";
export { CryptoFromRpc, CryptoRpcClient } from "./rpc/crypto-client.ts";
export { CryptoHandlersLive } from "./rpc/crypto-handlers.ts";
export {
  Blake2b256,
  CheckVrfLeader,
  CryptoRpcGroup,
  Ed25519Verify,
  KesSum6Verify,
  VrfProofToHash,
  VrfVerifyProof,
} from "./rpc/crypto-rpc.ts";
export { Crypto, CryptoDirect } from "./service.ts";

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
