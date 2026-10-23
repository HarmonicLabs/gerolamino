/**
 * Praos / TPraos header cryptography (ported from Gerolamo's browser node, docs/PLAN_BROWSER_NODE.md stage 2):
 *   1. operational certificate: the issuer's cold key signed (kesVkey ‖ counter ‖ kesPeriod);
 *   2. KES: the header body is signed by the KES key at evolution (slot / slotsPerKESPeriod − opcert period);
 *   3. VRF: the header's VRF proof verifies under the pool's VRF key for input blake2b(slot ‖ η0)
 *      (Praos) or the nonce/leader seeds (TPraos), and the carried output is the proof's hash.
 * All crypto is @harmoniclabs/crypto (ed25519, VrfProof03) and @harmoniclabs/kes (Sum6 KES).
 * Leader eligibility against the pool's stake is checked separately (leaderMath.ts).
 */
import { setEd25519Verify, verify as kesVerify } from "@harmoniclabs/kes";
import { praosVrfInput, tpraosVrfInput, u64be } from "./vrfInputs";
import { ed25519Verify, vrf03Verify } from "./vrf";
import { arrayElements, bytesAt, uintAt } from "./cbor";
import { toHex } from "@harmoniclabs/uint8array-utils";

setEd25519Verify(ed25519Verify);

export interface VrfCert { output: Uint8Array; proof: Uint8Array }

export interface HeaderCrypto {
    eraTag: number;
    slot: number;
    issuerVkey: Uint8Array;
    vrfVkey: Uint8Array;
    /** Praos: one VRF; TPraos: nonce and leader VRFs. */
    vrf: VrfCert | null;
    nonceVrf?: VrfCert;
    leaderVrf?: VrfCert;
    opcert: { kesVkey: Uint8Array; counter: bigint; kesPeriod: bigint; sig: Uint8Array };
    protocolVersion: [number, number];
    bodyBytes: Uint8Array;
    kesSignature: Uint8Array;
}

/** Split a Shelley-era header (`[body, kes_signature]`) into the fields the checks need. */
export function parseHeaderCrypto(headerBytes: Uint8Array, eraTag: number): HeaderCrypto {
    const [bodyR, sigR] = arrayElements(headerBytes, 0);
    const b = headerBytes;
    const f = arrayElements(b, bodyR!.start);
    const pair = (i: number): VrfCert => { const e = arrayElements(b, f[i]!.start); return { output: bytesAt(b, e[0]!.start), proof: bytesAt(b, e[1]!.start) }; };
    const slot = Number(uintAt(b, f[1]!.start));
    const issuerVkey = bytesAt(b, f[3]!.start), vrfVkey = bytesAt(b, f[4]!.start);
    if (eraTag >= 6) {
        // Babbage/Conway: [no, slot, prev, issuer, vrfVkey, vrf_result, size, hash, opcert[4], pv[2]]
        const oc = arrayElements(b, f[8]!.start);
        const pv = arrayElements(b, f[9]!.start);
        return {
            eraTag, slot, issuerVkey, vrfVkey, vrf: pair(5),
            opcert: { kesVkey: bytesAt(b, oc[0]!.start), counter: uintAt(b, oc[1]!.start), kesPeriod: uintAt(b, oc[2]!.start), sig: bytesAt(b, oc[3]!.start) },
            protocolVersion: [Number(uintAt(b, pv[0]!.start)), Number(uintAt(b, pv[1]!.start))],
            bodyBytes: b.subarray(bodyR!.start, bodyR!.end), kesSignature: bytesAt(b, sigR!.start),
        };
    }
    // Shelley…Alonzo: [no, slot, prev, issuer, vrfVkey, nonce_vrf, leader_vrf, size, hash, kesVkey, counter, period, sig, pvMajor, pvMinor]
    return {
        eraTag, slot, issuerVkey, vrfVkey, vrf: null, nonceVrf: pair(5), leaderVrf: pair(6),
        opcert: { kesVkey: bytesAt(b, f[9]!.start), counter: uintAt(b, f[10]!.start), kesPeriod: uintAt(b, f[11]!.start), sig: bytesAt(b, f[12]!.start) },
        protocolVersion: [Number(uintAt(b, f[13]!.start)), Number(uintAt(b, f[14]!.start))],
        bodyBytes: b.subarray(bodyR!.start, bodyR!.end), kesSignature: bytesAt(b, sigR!.start),
    };
}

/**
 * Operational certificates already verified (issuer key, certificate fields and signature, all as signed bytes).
 * A pool signs every block of a KES period with the same certificate, so most headers hit this cache and skip
 * one of their two ed25519 verifications (each ~55 ms on the BigInt ed25519 of @harmoniclabs/crypto). Only
 * successes are cached; the key is the full signed triple, so the result is exactly what verifying would return.
 */
const opcertOkCache = new Set<string>();
export function verifyOpcert(h: HeaderCrypto): boolean {
    const msg = concat(h.opcert.kesVkey, u64be(h.opcert.counter), u64be(h.opcert.kesPeriod));
    const key = toHex(h.issuerVkey) + toHex(msg) + toHex(h.opcert.sig);
    if (opcertOkCache.has(key)) return true;
    const ok = ed25519Verify(h.opcert.sig, msg, h.issuerVkey);
    if (ok) { if (opcertOkCache.size >= 4096) opcertOkCache.clear(); opcertOkCache.add(key); }
    return ok;
}

function concat(...parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface HeaderCryptoResult {
    opcertOk: boolean;
    kesOk: boolean;
    vrfOk: boolean;
    kesEvolution: number;
    detail: string[];
    /** Milliseconds spent per stage (for the stats page and benchmarks). */
    ms: { opcert: number; kes: number; vrf: number };
}

export function verifyHeaderCrypto(h: HeaderCrypto, epochNonce: Uint8Array, slotsPerKESPeriod: number, maxKESEvolutions: number): HeaderCryptoResult {
    const detail: string[] = [];
    const t0 = performance.now();
    // 1. operational certificate
    const opcertOk = verifyOpcert(h);
    if (!opcertOk) detail.push("opcert signature does not verify under the issuer key");
    const t1 = performance.now();
    // 2. KES
    const slotPeriod = Math.floor(h.slot / slotsPerKESPeriod);
    const kesEvolution = slotPeriod - Number(h.opcert.kesPeriod);
    let kesOk = false;
    if (kesEvolution < 0) detail.push("header slot is before the opcert's KES period");
    else if (kesEvolution >= maxKESEvolutions) detail.push(`KES key expired (evolution ${kesEvolution} ≥ ${maxKESEvolutions})`);
    else {
        try { kesOk = kesVerify(h.kesSignature, kesEvolution, h.opcert.kesVkey, h.bodyBytes); } catch (e) { detail.push(`KES verify threw: ${(e as Error).message}`); }
        if (!kesOk && !detail.length) detail.push("KES signature does not verify");
    }
    const t2 = performance.now();
    // 3. VRF
    let vrfOk = false;
    const slot = BigInt(h.slot);
    if (h.vrf) {
        const out = vrf03Verify(h.vrfVkey, praosVrfInput(slot, epochNonce), h.vrf.proof);
        vrfOk = !!out && eq(out, h.vrf.output);
        if (!vrfOk) detail.push("Praos VRF proof does not verify for blake2b(slot ‖ η0)");
    } else if (h.nonceVrf && h.leaderVrf) {
        const n = vrf03Verify(h.vrfVkey, tpraosVrfInput(slot, epochNonce, "nonce"), h.nonceVrf.proof);
        const l = n ? vrf03Verify(h.vrfVkey, tpraosVrfInput(slot, epochNonce, "leader"), h.leaderVrf.proof) : null;
        vrfOk = !!n && !!l && eq(n, h.nonceVrf.output) && eq(l, h.leaderVrf.output);
        if (!vrfOk) detail.push("TPraos nonce/leader VRF proofs do not verify");
    }
    const t3 = performance.now();
    return { opcertOk, kesOk, vrfOk, kesEvolution, detail, ms: { opcert: t1 - t0, kes: t2 - t1, vrf: t3 - t2 } };
}
