/**
 * VRF on @harmoniclabs/crypto against real preprod headers with their epoch nonces (Koios epoch_params),
 * ported from Gerolamo's vrfInputs.test.ts / fastVrf.test.ts with @noble replaced by the HarmonicLabs code.
 */
import { describe, expect, test } from "bun:test";
import { VrfProof03, VrfProof10, deriveEd25519PublicKey_sync } from "@harmoniclabs/crypto";
import { locateHeader } from "../src/node/chunkFormat";
import { parseHeaderCrypto } from "../src/node/headerVerify";
import { praosVrfInput, tpraosVrfInput } from "../src/node/vrfInputs";
import { vrf03ProofToHash, vrf03Verify, vrf10Verify } from "../src/node/vrf";
import { bytesToHex, preprodFixture } from "./lib/chunkReader";

const fx = preprodFixture();
const header = (block: Uint8Array) => { const l = locateHeader(block); return parseHeaderCrypto(block.subarray(l.headerOffset, l.headerOffset + l.headerSize), l.eraTag); };

describe("VRF inputs and VrfProof03 against real headers", () => {
    test("TPraos: Shelley block at slot 86400 (epoch 4): leader and nonce proofs verify; swapped seeds and a wrong nonce fail", () => {
        const h = header(fx.shelley);
        expect(h.eraTag).toBe(2);
        expect(h.slot).toBe(86400);
        const slot = BigInt(h.slot);
        const leader = vrf03Verify(h.vrfVkey, tpraosVrfInput(slot, fx.nonceEpoch4, "leader"), h.leaderVrf!.proof);
        const nonce = vrf03Verify(h.vrfVkey, tpraosVrfInput(slot, fx.nonceEpoch4, "nonce"), h.nonceVrf!.proof);
        expect(leader && bytesToHex(leader)).toBe(bytesToHex(h.leaderVrf!.output));
        expect(nonce && bytesToHex(nonce)).toBe(bytesToHex(h.nonceVrf!.output));
        expect(vrf03Verify(h.vrfVkey, tpraosVrfInput(slot, fx.nonceEpoch4, "nonce"), h.leaderVrf!.proof)).toBeNull();
        expect(vrf03Verify(h.vrfVkey, tpraosVrfInput(slot, fx.nonceEpoch310, "leader"), h.leaderVrf!.proof)).toBeNull();
    });

    test("Praos: Conway block (epoch 310): proof verifies, output is the proof hash, wrong nonce fails", () => {
        const h = header(fx.conway);
        expect(h.eraTag).toBe(7);
        const out = vrf03Verify(h.vrfVkey, praosVrfInput(BigInt(h.slot), fx.nonceEpoch310), h.vrf!.proof);
        expect(out && bytesToHex(out)).toBe(bytesToHex(h.vrf!.output));
        expect(bytesToHex(vrf03ProofToHash(h.vrf!.proof)!)).toBe(bytesToHex(h.vrf!.output));
        expect(vrf03Verify(h.vrfVkey, praosVrfInput(BigInt(h.slot), fx.nonceEpoch4), h.vrf!.proof)).toBeNull();
    });
});

describe("vrf03Verify wrapper", () => {
    const sk = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
    const pk = deriveEd25519PublicKey_sync(sk);
    const alpha = new Uint8Array(40).map((_, i) => i);
    const proof = VrfProof03.generate(sk, pk, alpha).toBytes();

    test("generated proofs verify and their output is the proof hash", () => {
        const out = vrf03Verify(pk, alpha, proof);
        expect(out).not.toBeNull();
        expect(bytesToHex(out!)).toBe(bytesToHex(VrfProof03.fromBytes(proof).toHash()));
    });

    test("tampered challenge or response, a wrong key, a wrong input and a short proof are rejected (never throw)", () => {
        const badC = Uint8Array.from(proof); badC[40]! ^= 1;
        const badS = Uint8Array.from(proof); badS[50]! ^= 1;
        expect(vrf03Verify(pk, alpha, badC)).toBeNull();
        expect(vrf03Verify(pk, alpha, badS)).toBeNull();
        expect(vrf03Verify(deriveEd25519PublicKey_sync(new Uint8Array(32).fill(9)), alpha, proof)).toBeNull();
        expect(vrf03Verify(pk, alpha.slice(1), proof)).toBeNull();
        expect(vrf03Verify(pk, alpha, proof.slice(1))).toBeNull();
        expect(vrf03Verify(new Uint8Array(32), alpha, proof)).toBeNull();
    });

    test("a non-canonical response (s + ℓ) is rejected as libsodium does", () => {
        const L = (1n << 252n) + 27742317777372353535851937790883648493n;
        let s = 0n; for (let i = 79; i >= 48; i--) s = (s << 8n) | BigInt(proof[i]!);
        const s2 = s + L;
        if (s2 < 1n << 256n) {
            const p2 = Uint8Array.from(proof);
            let x = s2; for (let i = 48; i < 80; i++) { p2[i] = Number(x & 0xffn); x >>= 8n; }
            expect(vrf03Verify(pk, alpha, p2)).toBeNull();
        }
    });

    test("draft-13 (VrfProof10) round trip through the wrapper", () => {
        const p10 = VrfProof10.generate(sk, pk, alpha).toBytes();
        const out = vrf10Verify(pk, alpha, p10);
        expect(out).not.toBeNull();
        expect(vrf10Verify(pk, alpha.slice(1), p10)).toBeNull();
    });
});

describe("ed25519Verify wrapper", () => {
    test("valid signatures verify; S + ℓ (malleated, accepted by verifyEd25519Signature_sync) is rejected", async () => {
        const { signEd25519_sync, verifyEd25519Signature_sync } = await import("@harmoniclabs/crypto");
        const { ed25519Verify } = await import("../src/node/vrf");
        const L = (1n << 252n) + 27742317777372353535851937790883648493n;
        let checked = 0;
        for (let k = 0; k < 30 && checked < 1; k++) {
            const msg = new Uint8Array([1, 2, 3, k]);
            const { signature, pubKey } = signEd25519_sync(msg, new Uint8Array(32).fill(k + 1));
            expect(ed25519Verify(signature, msg, pubKey)).toBe(true);
            expect(ed25519Verify(signature, new Uint8Array([9]), pubKey)).toBe(false);
            let s = 0n; for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(signature[i]!);
            if (s + L >= 1n << 256n) continue;
            const sig2 = Uint8Array.from(signature); let x = s + L; for (let i = 32; i < 64; i++) { sig2[i] = Number(x & 0xffn); x >>= 8n; }
            expect(verifyEd25519Signature_sync(sig2, msg, pubKey)).toBe(true); // the library's own check (documents the gap)
            expect(ed25519Verify(sig2, msg, pubKey)).toBe(false);
            checked++;
        }
        expect(checked).toBe(1);
    });
});
