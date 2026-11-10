/**
 * ECVRF-ED25519-SHA512-Elligator2 (draft-03, suite 0x04) verification with the noble group operations.
 *
 * The algorithm is NOT reimplemented here. `hash_to_curve` and `compute_challenge` come from
 * @harmoniclabs/crypto's port of the Rust `vrf_dalek` crate (`rust_vrf_reimpl/vrf03.js`), so suite bytes,
 * truncation, bit masking and the challenge encoding are exactly the ones Cardano uses. Only the elliptic
 * curve arithmetic is swapped: two four-scalar combinations per proof, done with noble's ExtendedPoint
 * (which is ~50x faster than the BigInt field code the port uses).
 *
 * Anything the curve layer cannot decode returns null, i.e. "not a valid proof", never "verified".
 */
import { sha2_512_sync } from "@harmoniclabs/crypto";
import { ed25519 } from "@harmoniclabs/crypto/dist/noble/ed25519.js";
import {
    vrf_ed25519_sha512_ell2_compute_challenge,
    vrf_ed25519_sha512_ell2_hash_to_curve
} from "@harmoniclabs/crypto/dist/rust_vrf_reimpl/vrf03.js";

const SUITE = 0x04;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function leToBigint(bytes: Uint8Array): bigint {
    let x = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]!);
    return x;
}

export interface NobleVerdict {
    /** The 64-byte VRF output (proof hash), or null when the proof does not verify. */
    output: Uint8Array | null;
    /** Which curve layer produced the answer; "noble" unless the fast path threw. */
    engine: "noble" | "error";
}

/**
 * Verify an 80-byte draft-03 proof: gamma(32) || challenge(16) || response(32).
 * Returns the 64-byte proof hash on success and null on every failure mode.
 */
export function vrf03VerifyNoble(publicKey: Uint8Array, alpha: Uint8Array, proof: Uint8Array): Uint8Array | null {
    if (proof.length !== 80 || publicKey.length !== 32) return null;
    const gammaBytes = proof.subarray(0, 32);
    const challengeBytes = proof.subarray(32, 48);
    const responseBytes = proof.subarray(48, 80);
    // libsodium rejects a non-canonical response; keep that before any curve work
    if (leToBigint(responseBytes) >= L) return null;

    try {
        const Y = ed25519.ExtendedPoint.fromHex(publicKey);
        // the reference implementation refuses a small-order public key
        if (Y.isSmallOrder()) return null;
        const gamma = ed25519.ExtendedPoint.fromHex(gammaBytes);
        const hBytes = vrf_ed25519_sha512_ell2_hash_to_curve(publicKey, alpha).compress();
        const h = ed25519.ExtendedPoint.fromHex(hBytes);

        const c = leToBigint(challengeBytes);
        const s = leToBigint(responseBytes);

        // U = s*B - c*Y ; V = s*H - c*Gamma  (the two four-scalar combinations of the proof)
        const U = ed25519.ExtendedPoint.BASE.multiply(s).add(Y.multiply(c).negate());
        const V = h.multiply(s).add(gamma.multiply(c).negate());

        const computed = vrf_ed25519_sha512_ell2_compute_challenge(hBytes, gammaBytes, U.toRawBytes(), V.toRawBytes());
        for (let i = 0; i < 16; i++) if (computed[i] !== challengeBytes[i]) return null;

        // output = SHA512(suite || 0x03 || cofactor*Gamma): 64 bytes, as Cardano's header VRF output is
        const gammaCofactor = gamma.clearCofactor().toRawBytes();
        const input = new Uint8Array(2 + gammaCofactor.length);
        input[0] = SUITE;
        input[1] = 0x03;
        input.set(gammaCofactor, 2);
        // draft-03 output for ed25519-sha512 is the WHOLE SHA-512 digest (64 bytes), not a truncation
        return sha2_512_sync(input);
    } catch {
        return null;
    }
}
