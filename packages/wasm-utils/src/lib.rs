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
pub fn ed25519_verify(message: &[u8], signature: &[u8], public_key: &[u8]) -> Result<bool, JsValue> {
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
pub fn ed25519_extended_sign(message: &[u8], extended_secret_key: &[u8]) -> Result<Vec<u8>, JsValue> {
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
