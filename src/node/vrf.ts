/**
 * Header VRF and ed25519 verification on @harmoniclabs/crypto only.
 *
 * Cardano block headers (Shelley through Conway) carry ECVRF-ED25519-SHA512-Elligator2 proofs of the
 * IETF draft-03 construction (libsodium `crypto_vrf_ietfdraft03_*`, 80-byte proofs). Gerolamo verified
 * them with its own `fastVrf.ts` on @noble/curves; Gerolamino uses `VrfProof03` from
 * @harmoniclabs/crypto, the pure-TS port of the Rust `vrf_dalek` crate. `VrfProof10` (draft-13) is the
 * batch-compatible variant no Cardano era uses for headers yet; it is exposed for completeness.
 *
 * Checks libsodium makes that @harmoniclabs/crypto 0.3.1 does not, added here so results match cardano-node:
 * the VRF response scalar s must be canonical (s < ℓ; `VrfProof03.verify` accepts s + ℓ), and so must an
 * ed25519 signature's S (`verifyEd25519Signature_sync` accepts S + ℓ).
 */
import { VrfProof03, VrfProof10, verifyEd25519Signature_sync } from "@harmoniclabs/crypto";

/** Order of the ed25519 prime-order subgroup. */
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function leToBigint(b: Uint8Array): bigint {
    let x = 0n;
    for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]!);
    return x;
}

/** Verify a draft-03 proof; returns the 64-byte VRF output (proof hash) or null. */
export function vrf03Verify(publicKey: Uint8Array, alpha: Uint8Array, proof: Uint8Array): Uint8Array | null {
    if (proof.length !== 80 || publicKey.length !== 32) return null;
    if (leToBigint(proof.subarray(48, 80)) >= L) return null; // non-canonical response, rejected by libsodium
    let p: VrfProof03;
    try { p = VrfProof03.fromBytes(proof); } catch { return null; }
    try { if (!p.verify(publicKey, alpha)) return null; } catch { return null; }
    return new Uint8Array(p.toHash());
}

/** Verify a draft-13 proof (not used by Cardano headers today). */
export function vrf10Verify(publicKey: Uint8Array, alpha: Uint8Array, proof: Uint8Array): Uint8Array | null {
    if (proof.length !== 80 || publicKey.length !== 32) return null;
    let p: VrfProof10;
    try { p = VrfProof10.fromBytes(proof); } catch { return null; }
    try { if (!p.verify(publicKey, alpha)) return null; } catch { return null; }
    return new Uint8Array(p.toHash());
}

/** The VRF output carried in a header must equal the proof's hash. */
export function vrf03ProofToHash(proof: Uint8Array): Uint8Array | null {
    try { return new Uint8Array(VrfProof03.fromBytes(proof).toHash()); } catch { return null; }
}

/**
 * Plain ed25519 signature check (opcert and the KES leaf); never throws. Rejects a non-canonical S (S ≥ ℓ) as
 * libsodium and RFC 8032 do: `verifyEd25519Signature_sync` alone accepts S + ℓ, i.e. malleated signatures.
 */
export function ed25519Verify(sig: Uint8Array, msg: Uint8Array, pk: Uint8Array): boolean {
    if (sig.length !== 64 || pk.length !== 32) return false;
    if (leToBigint(sig.subarray(32, 64)) >= L) return false;
    try { return verifyEd25519Signature_sync(sig, msg, pk); } catch { return false; }
}
