//! WASM bindings for Pallas Cardano primitives.
//!
//! Exposes blake2b hashing, ed25519 signing/verification, and address
//! bech32/base58 encoding/decoding via wasm-bindgen.

use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// Blake2b hashing
// ---------------------------------------------------------------------------

/// Compute Blake2b-256 hash (32-byte digest) of input bytes.
#[wasm_bindgen]
pub fn blake2b_256(data: &[u8]) -> Vec<u8> {
    let hash = pallas_crypto::hash::Hasher::<256>::hash(data);
    hash.as_ref().to_vec()
}

/// Compute Blake2b-224 hash (28-byte digest) of input bytes.
#[wasm_bindgen]
pub fn blake2b_224(data: &[u8]) -> Vec<u8> {
    let hash = pallas_crypto::hash::Hasher::<224>::hash(data);
    hash.as_ref().to_vec()
}

/// Compute Blake2b-256 hash with a domain-separation tag byte prepended.
/// Used for VRF nonce computation (tag 0x4c = leader, 0x4e = nonce).
#[wasm_bindgen]
pub fn blake2b_256_tagged(data: &[u8], tag: u8) -> Vec<u8> {
    let hash = pallas_crypto::hash::Hasher::<256>::hash_tagged(data, tag);
    hash.as_ref().to_vec()
}

// ---------------------------------------------------------------------------
// Ed25519 key operations
// ---------------------------------------------------------------------------

/// Generate a new Ed25519 secret key (32 bytes) from random bytes.
/// Requires a 32-byte seed.
#[wasm_bindgen]
pub fn ed25519_secret_key_from_seed(seed: &[u8]) -> Result<Vec<u8>, JsValue> {
    if seed.len() != 32 {
        return Err(JsValue::from_str("seed must be 32 bytes"));
    }
    // Use the seed directly as the secret key bytes
    Ok(seed.to_vec())
}

/// Derive the public key (32 bytes) from a secret key (32 bytes).
#[wasm_bindgen]
pub fn ed25519_public_key(secret_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    if secret_key.len() != 32 {
        return Err(JsValue::from_str("secret key must be 32 bytes"));
    }
    let mut sk_bytes = [0u8; 32];
    sk_bytes.copy_from_slice(secret_key);

    let sk = pallas_crypto::key::ed25519::SecretKey::from(sk_bytes);
    let pk = sk.public_key();
    Ok(pk.as_ref().to_vec())
}

/// Sign a message with an Ed25519 secret key.
/// Returns a 64-byte signature.
#[wasm_bindgen]
pub fn ed25519_sign(message: &[u8], secret_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    if secret_key.len() != 32 {
        return Err(JsValue::from_str("secret key must be 32 bytes"));
    }
    let mut sk_bytes = [0u8; 32];
    sk_bytes.copy_from_slice(secret_key);

    let sk = pallas_crypto::key::ed25519::SecretKey::from(sk_bytes);
    let sig = sk.sign(message);
    Ok(sig.as_ref().to_vec())
}

/// Verify an Ed25519 signature.
/// Returns true if the signature is valid.
#[wasm_bindgen]
pub fn ed25519_verify(
    message: &[u8],
    signature: &[u8],
    public_key: &[u8],
) -> Result<bool, JsValue> {
    if signature.len() != 64 {
        return Err(JsValue::from_str("signature must be 64 bytes"));
    }
    if public_key.len() != 32 {
        return Err(JsValue::from_str("public key must be 32 bytes"));
    }
    let mut sig_bytes = [0u8; 64];
    sig_bytes.copy_from_slice(signature);

    let mut pk_bytes = [0u8; 32];
    pk_bytes.copy_from_slice(public_key);

    let pk = pallas_crypto::key::ed25519::PublicKey::from(pk_bytes);
    let sig = pallas_crypto::key::ed25519::Signature::from(sig_bytes);

    Ok(pk.verify(message, &sig))
}

// ---------------------------------------------------------------------------
// Ed25519-Extended key operations (for HD wallets)
// ---------------------------------------------------------------------------

/// Derive the public key from an extended secret key (64 bytes).
#[wasm_bindgen]
pub fn ed25519_extended_public_key(extended_secret_key: &[u8]) -> Result<Vec<u8>, JsValue> {
    if extended_secret_key.len() != 64 {
        return Err(JsValue::from_str("extended secret key must be 64 bytes"));
    }
    let mut sk_bytes = [0u8; 64];
    sk_bytes.copy_from_slice(extended_secret_key);

    let sk = pallas_crypto::key::ed25519::SecretKeyExtended::from_bytes(sk_bytes)
        .map_err(|e| JsValue::from_str(&format!("invalid extended key: {:?}", e)))?;
    let pk = sk.public_key();
    Ok(pk.as_ref().to_vec())
}

/// Sign with an extended secret key (64 bytes).
#[wasm_bindgen]
pub fn ed25519_extended_sign(
    message: &[u8],
    extended_secret_key: &[u8],
) -> Result<Vec<u8>, JsValue> {
    if extended_secret_key.len() != 64 {
        return Err(JsValue::from_str("extended secret key must be 64 bytes"));
    }
    let mut sk_bytes = [0u8; 64];
    sk_bytes.copy_from_slice(extended_secret_key);

    let sk = pallas_crypto::key::ed25519::SecretKeyExtended::from_bytes(sk_bytes)
        .map_err(|e| JsValue::from_str(&format!("invalid extended key: {:?}", e)))?;
    let sig = sk.sign(message);
    Ok(sig.as_ref().to_vec())
}

// ---------------------------------------------------------------------------
// Address encoding/decoding
// ---------------------------------------------------------------------------

/// Encode address bytes to bech32 string.
/// Automatically determines the correct prefix (addr, addr_test, stake, stake_test).
#[wasm_bindgen]
pub fn address_to_bech32(bytes: &[u8]) -> Result<String, JsValue> {
    let addr = pallas_addresses::Address::from_bytes(bytes)
        .map_err(|e| JsValue::from_str(&format!("invalid address bytes: {}", e)))?;
    addr.to_bech32()
        .map_err(|e| JsValue::from_str(&format!("bech32 encoding failed: {}", e)))
}

/// Decode a bech32 address string to bytes.
#[wasm_bindgen]
pub fn address_from_bech32(bech32: &str) -> Result<Vec<u8>, JsValue> {
    let addr = pallas_addresses::Address::from_bech32(bech32)
        .map_err(|e| JsValue::from_str(&format!("invalid bech32: {}", e)))?;
    Ok(addr.to_vec())
}

/// Encode address bytes to hex string.
#[wasm_bindgen]
pub fn address_to_hex(bytes: &[u8]) -> Result<String, JsValue> {
    let addr = pallas_addresses::Address::from_bytes(bytes)
        .map_err(|e| JsValue::from_str(&format!("invalid address bytes: {}", e)))?;
    Ok(addr.to_hex())
}

/// Decode a hex-encoded address to bytes.
#[wasm_bindgen]
pub fn address_from_hex(hex_str: &str) -> Result<Vec<u8>, JsValue> {
    let addr = pallas_addresses::Address::from_hex(hex_str)
        .map_err(|e| JsValue::from_str(&format!("invalid hex address: {}", e)))?;
    Ok(addr.to_vec())
}

/// Get the network of an address (0 = testnet, 1 = mainnet).
/// Returns None for Byron addresses.
#[wasm_bindgen]
pub fn address_network(bytes: &[u8]) -> Result<Option<u8>, JsValue> {
    let addr = pallas_addresses::Address::from_bytes(bytes)
        .map_err(|e| JsValue::from_str(&format!("invalid address: {}", e)))?;
    Ok(addr.network().map(|n| n.value()))
}

/// Check if an address is a script address.
#[wasm_bindgen]
pub fn address_has_script(bytes: &[u8]) -> Result<bool, JsValue> {
    let addr = pallas_addresses::Address::from_bytes(bytes)
        .map_err(|e| JsValue::from_str(&format!("invalid address: {}", e)))?;
    Ok(addr.has_script())
}

/// Get the address type ID (header byte >> 4).
#[wasm_bindgen]
pub fn address_type_id(bytes: &[u8]) -> Result<u8, JsValue> {
    let addr = pallas_addresses::Address::from_bytes(bytes)
        .map_err(|e| JsValue::from_str(&format!("invalid address: {}", e)))?;
    Ok(addr.typeid())
}

// ---------------------------------------------------------------------------
// VRF Proof Verification (ECVRF-ED25519-SHA512-Elligator2, from Amaru)
// ---------------------------------------------------------------------------

/// Verify a VRF proof (ECVRF-ED25519-SHA512-Elligator2, IETF draft-03).
///
/// This is the VRF scheme used by Cardano (pre-Conway era).
///
/// Parameters:
/// - `vrf_vkey`: 32-byte VRF verification key
/// - `vrf_proof`: 80-byte VRF proof (gamma + challenge + response)
/// - `vrf_input`: 32-byte VRF input (blake2b-256 of slot || epoch_nonce)
///
/// Returns the 64-byte VRF proof hash on success, or an error string on failure.
/// A non-error result means the proof is valid.
#[wasm_bindgen]
pub fn vrf_verify_proof(
    vrf_vkey: &[u8],
    vrf_proof: &[u8],
    vrf_input: &[u8],
) -> Result<Vec<u8>, JsValue> {
    use vrf_dalek::vrf03::{PublicKey03, VrfProof03};

    if vrf_vkey.len() != 32 {
        return Err(JsValue::from_str("VRF verification key must be 32 bytes"));
    }
    if vrf_proof.len() != 80 {
        return Err(JsValue::from_str("VRF proof must be 80 bytes"));
    }

    let pk = PublicKey03::from_bytes(<&[u8; 32]>::try_from(vrf_vkey).unwrap());

    let proof = VrfProof03::from_bytes(<&[u8; 80]>::try_from(vrf_proof).unwrap())
        .map_err(|e| JsValue::from_str(&format!("invalid VRF proof: {:?}", e)))?;

    let proof_hash = proof
        .verify(&pk, vrf_input)
        .map_err(|e| JsValue::from_str(&format!("VRF proof verification failed: {:?}", e)))?;

    Ok(proof_hash.to_vec())
}

/// Compute the VRF proof-to-hash (SHA-512 output) without verifying.
/// Useful for computing the leader VRF output from a known-good proof.
///
/// Parameters:
/// - `vrf_proof`: 80-byte VRF proof
///
/// Returns the 64-byte hash.
#[wasm_bindgen]
pub fn vrf_proof_to_hash(vrf_proof: &[u8]) -> Result<Vec<u8>, JsValue> {
    use vrf_dalek::vrf03::VrfProof03;

    if vrf_proof.len() != 80 {
        return Err(JsValue::from_str("VRF proof must be 80 bytes"));
    }

    let proof = VrfProof03::from_bytes(<&[u8; 80]>::try_from(vrf_proof).unwrap())
        .map_err(|e| JsValue::from_str(&format!("invalid VRF proof: {:?}", e)))?;

    Ok(proof.proof_to_hash().to_vec())
}

// ---------------------------------------------------------------------------
// VRF Threshold Math — leader election via pallas-math
// ---------------------------------------------------------------------------

/// Check if a VRF output qualifies the pool as slot leader.
///
/// Implements the Ouroboros Praos leader election:
///   isLeader ⟺ vrfOutput < 2^{ℓ_VRF} · ϕ_f(σ)
///   where ϕ_f(σ) = 1 - (1-f)^σ
///
/// Uses the optimized exponential comparison:
///   exp(σ · ln(1-f)) < 1/(1-vrfNormalized)
///
/// Parameters:
/// - `vrf_output_hex`: hex-encoded VRF output (64 bytes = 512 bits)
/// - `sigma_numerator`: pool active stake (numerator)
/// - `sigma_denominator`: total active stake (denominator)
/// - `active_slot_coeff_num`: active slot coefficient numerator (e.g., 5 for f=0.05)
/// - `active_slot_coeff_den`: active slot coefficient denominator (e.g., 100)
///
/// Returns true if the pool is a slot leader for this VRF output.
#[wasm_bindgen]
pub fn check_vrf_leader(
    vrf_output_hex: &str,
    sigma_numerator: &str,
    sigma_denominator: &str,
    active_slot_coeff_num: &str,
    active_slot_coeff_den: &str,
) -> Result<bool, JsValue> {
    use pallas_math::math::{DEFAULT_PRECISION, ExpOrdering, FixedDecimal, FixedPrecision};

    let one = FixedDecimal::from(1u64);

    // Parse sigma = stake_numerator / stake_denominator
    let sigma_n = FixedDecimal::from_str(sigma_numerator, DEFAULT_PRECISION)
        .map_err(|e| JsValue::from_str(&format!("invalid sigma_numerator: {}", e)))?;
    let sigma_d = FixedDecimal::from_str(sigma_denominator, DEFAULT_PRECISION)
        .map_err(|e| JsValue::from_str(&format!("invalid sigma_denominator: {}", e)))?;
    let sigma = &sigma_n / &sigma_d;

    // Parse f = active_slot_coeff_num / active_slot_coeff_den
    let f_n = FixedDecimal::from_str(active_slot_coeff_num, DEFAULT_PRECISION)
        .map_err(|e| JsValue::from_str(&format!("invalid coeff_num: {}", e)))?;
    let f_d = FixedDecimal::from_str(active_slot_coeff_den, DEFAULT_PRECISION)
        .map_err(|e| JsValue::from_str(&format!("invalid coeff_den: {}", e)))?;
    let f = &f_n / &f_d;

    // Parse VRF output as FixedDecimal (interpret raw hex bytes as big integer)
    let vrf_normalized = FixedDecimal::from_str(vrf_output_hex, DEFAULT_PRECISION)
        .map_err(|e| JsValue::from_str(&format!("invalid vrf_output_hex: {}", e)))?;

    // Compute: exp(sigma * ln(1 - f)) < 1 / (1 - vrfNormalized)
    let c = &one - &f; // 1 - f
    let temp = c.ln(); // ln(1 - f)
    let alpha = -(&sigma * &temp); // -sigma * ln(1-f) = sigma * (-ln(1-f))
    let q_ = &one - &vrf_normalized; // 1 - vrfNormalized
    let q = &one / &q_; // 1 / (1 - vrfNormalized)

    let res = alpha.exp_cmp(1000, 3, &q);

    // LT means exp(alpha) < q, so the pool IS a leader
    Ok(res.estimation == ExpOrdering::LT)
}

/// Compute the VRF input for a given slot and epoch nonce.
///
/// VRF input = blake2b-256(slot_bytes || epoch_nonce || tag_bytes)
/// where tag = "L" (0x4c) for leader election, "N" (0x4e) for nonce evolution.
#[wasm_bindgen]
pub fn vrf_derive_input(slot: u64, epoch_nonce: &[u8], tag: u8) -> Vec<u8> {
    let mut input = Vec::with_capacity(8 + epoch_nonce.len() + 1);
    input.extend_from_slice(&slot.to_be_bytes());
    input.extend_from_slice(epoch_nonce);
    input.push(tag);
    let hash = pallas_crypto::hash::Hasher::<256>::hash(&input);
    hash.as_ref().to_vec()
}

/// Evolve the nonce with a new VRF output.
///
/// nonce' = blake2b-256(current_nonce || blake2b-256(vrf_output))
#[wasm_bindgen]
pub fn evolve_nonce(current_nonce: &[u8], vrf_output: &[u8]) -> Vec<u8> {
    let vrf_hash = pallas_crypto::hash::Hasher::<256>::hash(vrf_output);
    let mut combined = Vec::with_capacity(current_nonce.len() + 32);
    combined.extend_from_slice(current_nonce);
    combined.extend_from_slice(vrf_hash.as_ref());
    let result = pallas_crypto::hash::Hasher::<256>::hash(&combined);
    result.as_ref().to_vec()
}

/// Derive epoch nonce from candidate nonce at epoch boundary.
///
/// epoch_nonce = blake2b-256(candidate_nonce || prev_epoch_last_block_hash)
#[wasm_bindgen]
pub fn derive_epoch_nonce(candidate_nonce: &[u8], prev_epoch_last_hash: &[u8]) -> Vec<u8> {
    let mut combined = Vec::with_capacity(candidate_nonce.len() + prev_epoch_last_hash.len());
    combined.extend_from_slice(candidate_nonce);
    combined.extend_from_slice(prev_epoch_last_hash);
    let result = pallas_crypto::hash::Hasher::<256>::hash(&combined);
    result.as_ref().to_vec()
}

// ---------------------------------------------------------------------------
// KES (Key Evolving Signatures) — for consensus block header verification
// ---------------------------------------------------------------------------

/// Verify a KES signature (Sum6, depth 6 = 64 key evolutions).
/// This is what Cardano mainnet uses for block production.
///
/// - `signature_bytes`: The KES signature bytes
/// - `period`: The KES evolution period (0..63 for Sum6)
/// - `public_key`: The 32-byte KES public key
/// - `message`: The message that was signed
///
/// Returns true if valid, false otherwise.
#[wasm_bindgen]
pub fn kes_sum6_verify(
    signature_bytes: &[u8],
    period: u32,
    public_key: &[u8],
    message: &[u8],
) -> Result<bool, JsValue> {
    use pallas_crypto::kes::common::PublicKey;
    use pallas_crypto::kes::traits::KesSig;

    if public_key.len() != 32 {
        return Err(JsValue::from_str("KES public key must be 32 bytes"));
    }

    let pk = PublicKey::from_bytes(public_key)
        .map_err(|e| JsValue::from_str(&format!("invalid KES public key: {:?}", e)))?;

    // Try to deserialize the signature and verify
    let sig = pallas_crypto::kes::summed_kes::Sum6KesSig::from_bytes(signature_bytes)
        .map_err(|e| JsValue::from_str(&format!("invalid KES signature: {:?}", e)))?;

    match sig.verify(period, &pk, message) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}
