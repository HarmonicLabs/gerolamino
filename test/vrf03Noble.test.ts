import { describe, expect, test } from "bun:test";
import { VrfProof03 } from "@harmoniclabs/crypto";
import { ed25519 } from "@harmoniclabs/crypto/dist/noble/ed25519.js";
import { locateHeader } from "../src/node/chunkFormat";
import { parseHeaderCrypto } from "../src/node/headerVerify";
import { praosVrfInput, tpraosVrfInput } from "../src/node/vrfInputs";
import { hashToCurveNoble, vrf03VerifyNoble } from "../src/node/vrf03Noble";
import { vrf_ed25519_sha512_ell2_hash_to_curve } from "@harmoniclabs/crypto/dist/rust_vrf_reimpl/vrf03.js";
import { preprodFixture } from "./lib/chunkReader";

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const rand = (n: number): Uint8Array => Uint8Array.from(crypto.getRandomValues(new Uint8Array(n)));
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

/** The reference implementation: @harmoniclabs/crypto's Rust port, what gerolamino used before. */
const reference = (pk: Uint8Array, alpha: Uint8Array, proof: Uint8Array): Uint8Array | null => {
    if (proof.length !== 80 || pk.length !== 32) return null;
    try {
        const p = VrfProof03.fromBytes(proof);
        if (!p.verify(pk, alpha)) return null;
        return new Uint8Array(p.toHash());
    } catch {
        return null;
    }
};

const fx = preprodFixture();
const headerOf = (block: Uint8Array) => {
    const l = locateHeader(block);
    const h = parseHeaderCrypto(block.subarray(l.headerOffset, l.headerOffset + l.headerSize), l.eraTag);
    // the VRF input is not the body: Tpraos signs (slot, nonce, "leader"/"nonce"), Praos signs (slot, nonce)
    return h.vrf
        ? { vrfVkey: h.vrfVkey, proof: h.vrf.proof, alpha: praosVrfInput(BigInt(h.slot), fx.nonceEpoch310), expected: h.vrf.output }
        : { vrfVkey: h.vrfVkey, proof: h.leaderVrf!.proof, alpha: tpraosVrfInput(BigInt(h.slot), fx.nonceEpoch4, "leader"), expected: h.leaderVrf!.output };
};

describe("noble hash_to_curve is byte-identical to the port", () => {
    test("200 random (public key, alpha) pairs produce the same compressed point", () => {
        for (let i = 0; i < 200; i++) {
            const pk = rand(32);
            const alpha = rand(i % 37);
            const fast = hashToCurveNoble(pk, alpha);
            const slow = vrf_ed25519_sha512_ell2_hash_to_curve(pk, alpha).compress();
            expect(hex(fast)).toBe(hex(slow));
        }
    }, 120_000);

    test("real header inputs produce the same compressed point", () => {
        for (const block of [fx.conway, fx.shelley]) {
            const { vrfVkey, alpha } = headerOf(block);
            expect(hex(hashToCurveNoble(vrfVkey, alpha))).toBe(hex(vrf_ed25519_sha512_ell2_hash_to_curve(vrfVkey, alpha).compress()));
        }
    }, 60_000);
});

describe("noble ECVRF verify agrees with @harmoniclabs/crypto on every case", () => {
    test("real preview headers: same verdict, same output", () => {
        for (const block of [fx.conway, fx.shelley]) {
            const { vrfVkey, proof, alpha, expected } = headerOf(block);
            const fast = vrf03VerifyNoble(vrfVkey, alpha, proof);
            const slow = reference(vrfVkey, alpha, proof);
            expect(slow).not.toBe(null);
            expect(fast).not.toBe(null);
            expect(hex(fast!)).toBe(hex(slow!));
            // and both equal the output the real header carries
            expect(hex(fast!)).toBe(hex(expected));
        }
    }, 60_000);

    test("generated proofs: same verdict, same output", () => {
        for (let i = 0; i < 4; i++) {
            const secret = rand(32);
            const pk = ed25519.getPublicKey(secret);
            const alpha = rand(32 + i * 7);
            const proof = new Uint8Array(VrfProof03.generate(secret, pk, alpha).toBytes());
            const fast = vrf03VerifyNoble(pk, alpha, proof);
            const slow = reference(pk, alpha, proof);
            expect(slow).not.toBe(null);
            expect(fast).not.toBe(null);
            expect(hex(fast!)).toBe(hex(slow!));
        }
    }, 120_000);

    test("every mutation gets the same verdict from both", () => {
        const secret = rand(32);
        const pk = ed25519.getPublicKey(secret);
        const alpha = new TextEncoder().encode("gerolamino ecvrf parity");
        const proof = new Uint8Array(VrfProof03.generate(secret, pk, alpha).toBytes());

        const mutations: Array<{ name: string; pk?: Uint8Array; alpha?: Uint8Array; proof: Uint8Array }> = [
            { name: "gamma byte flipped", proof: flip(proof, 0) },
            { name: "challenge byte flipped", proof: flip(proof, 32) },
            { name: "response byte flipped", proof: flip(proof, 48) },
            { name: "short proof", proof: proof.subarray(0, 79) },
            { name: "wrong public key", pk: ed25519.getPublicKey(rand(32)), proof },
            { name: "wrong alpha", alpha: new TextEncoder().encode("different"), proof }
        ];
        for (const m of mutations) {
            const fast = vrf03VerifyNoble(m.pk ?? pk, m.alpha ?? alpha, m.proof) !== null;
            const slow = reference(m.pk ?? pk, m.alpha ?? alpha, m.proof) !== null;
            expect({ name: m.name, verdict: fast }).toEqual({ name: m.name, verdict: slow });
        }
    }, 120_000);

    test("a non-canonical response (s + L) is rejected by the fast path too", () => {
        const secret = rand(32);
        const pk = ed25519.getPublicKey(secret);
        const alpha = new TextEncoder().encode("non-canonical");
        const proof = new Uint8Array(VrfProof03.generate(secret, pk, alpha).toBytes());
        const s = leToBigint(proof.subarray(48, 80)) + L;
        const mutated = Uint8Array.from(proof);
        mutated.set(leFromBigint(s, 32), 48);
        expect(vrf03VerifyNoble(pk, alpha, mutated)).toBe(null);
    }, 60_000);
});

function flip(bytes: Uint8Array, at: number): Uint8Array {
    const out = Uint8Array.from(bytes);
    out[at] = out[at]! ^ 0x01;
    return out;
}

function leToBigint(bytes: Uint8Array): bigint {
    let x = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]!);
    return x;
}

function leFromBigint(value: bigint, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let v = value;
    for (let i = 0; i < length; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
}
