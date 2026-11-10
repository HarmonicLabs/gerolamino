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
    vrf_ed25519_sha512_ell2_compute_challenge
} from "@harmoniclabs/crypto/dist/rust_vrf_reimpl/vrf03.js";

const SUITE = 0x04;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

// ---- hash_to_curve (Elligator2, draft-03 section 5.4.1.2) on noble's field ----
// Ported line for line from @harmoniclabs/crypto's curves.js, including its one deliberate deviation from
// curve25519-dalek (the `flipped_sign_sqrt_i` case in sqrt_ratio_i, without which the Elligator round trip
// fails). Very fast because noble's field code is; correctness is proven against the port itself over random
// inputs and against the published draft-03 vectors.

const Fp = (ed25519 as unknown as { CURVE: { Fp: any } }).CURVE.Fp;
const P: bigint = Fp.ORDER;
const ONE: bigint = Fp.create(1n);
const MONTGOMERY_A: bigint = Fp.create(486662n);
const MONTGOMERY_A_NEG: bigint = Fp.create(P - 486662n);
/** curve25519-dalek's SQRT_M1, one specific square root of -1. */
const SQRT_M1: bigint = Fp.create(19681161376707505956807079304988542015446066515923890162744021073123829784752n);

function leBytesToField(bytes: Uint8Array): bigint {
    const b = Uint8Array.from(bytes);
    b[31] = b[31]! & 0x7f;   // dalek masks the top bit
    let x = 0n;
    for (let i = 31; i >= 0; i--) x = (x << 8n) | BigInt(b[i]!);
    return Fp.create(x);
}

function fieldToLe32(x: bigint): Uint8Array {
    const out = new Uint8Array(32);
    let v = Fp.create(x);
    for (let i = 0; i < 32; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
}

const isNegative = (x: bigint): boolean => (Fp.create(x) & 1n) === 1n;

/** dalek's sqrt_ratio_i(u, v): is u/v a square, and its canonical (non-negative) root. */
function sqrtRatioI(u: bigint, v: bigint): { isValid: boolean; r: bigint } {
    const v3 = Fp.mul(Fp.sqr(v), v);
    const v7 = Fp.mul(Fp.sqr(v3), v);
    let r = Fp.mul(Fp.mul(u, v3), Fp.pow(Fp.mul(u, v7), (P - 5n) / 8n));
    const check = Fp.mul(v, Fp.sqr(r));
    const uNeg = Fp.neg(u);
    const correctSignSqrt = Fp.eql(check, u);
    const flippedSignSqrt = Fp.eql(check, uNeg);
    const flippedSignSqrtI = Fp.eql(check, Fp.mul(uNeg, SQRT_M1));
    if (flippedSignSqrt || flippedSignSqrtI) r = Fp.mul(SQRT_M1, r);
    if (isNegative(r)) r = Fp.neg(r);
    return { isValid: correctSignSqrt || flippedSignSqrt, r };
}

/**
 * ECVRF_hash_to_curve_elligator2_25519: H = 8 * Elligator2(SHA-512(0x04 || 0x01 || pk || alpha)[0..32]).
 * Returns the compressed Edwards point (32 bytes), exactly what the reference implementation's `.compress()`
 * gives for the same input.
 */
export function hashToCurveNoble(publicKey: Uint8Array, alpha: Uint8Array): Uint8Array {
    const input = new Uint8Array(2 + publicKey.length + alpha.length);
    input[0] = SUITE;
    input[1] = 0x01;
    input.set(publicKey, 2);
    input.set(alpha, 2 + publicKey.length);
    const hash = sha2_512_sync(input);
    const r0 = leBytesToField(hash.subarray(0, 32));

    // Elligator2 encode: d1 = 1 + 2r^2 ; d = -A/d1 ; eps = d^3 + A d^2 + d ; u = d or -d-A
    const d1 = Fp.add(ONE, Fp.mul(Fp.create(2n), Fp.sqr(r0)));
    const d = Fp.mul(MONTGOMERY_A_NEG, Fp.inv(d1));
    const inner = Fp.add(Fp.add(Fp.sqr(d), Fp.mul(MONTGOMERY_A, d)), ONE);
    const eps = Fp.mul(d, inner);
    const { isValid } = sqrtRatioI(eps, ONE);
    let u = isValid ? d : Fp.add(d, MONTGOMERY_A);
    if (!isValid) u = Fp.neg(u);

    // Montgomery u -> Edwards y = (u-1)/(u+1), sign bit 0, then x is recovered by decompression
    const up1 = Fp.add(u, ONE);
    if (Fp.is0(up1)) throw new Error("elligator: u == -1 has no Edwards image");
    const y = Fp.mul(Fp.sub(u, ONE), Fp.inv(up1));
    const point = ed25519.ExtendedPoint.fromHex(fieldToLe32(y));
    return point.clearCofactor().toRawBytes();
}

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
        const hBytes = hashToCurveNoble(publicKey, alpha);
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
