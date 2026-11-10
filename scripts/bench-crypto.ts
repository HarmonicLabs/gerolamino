/**
 * Header-path crypto benchmark: what one header actually costs today, before any change.
 * Measures the three verifications every Shelley+ header needs (opcert ed25519, KES Sum6, VRF draft-03)
 * and the two candidate ed25519 implementations side by side.
 *
 *   bun scripts/bench-crypto.ts [--n 20]
 */
import { verifyEd25519Signature_sync, VrfProof03 } from "@harmoniclabs/crypto";

// The public noble port that ships inside @harmoniclabs/crypto (no new dependency).
const noble = await import("@harmoniclabs/crypto/dist/noble/ed25519.js");

const arg = (name: string, fallback: number): number => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const N = Math.max(3, arg("n", 20));

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

async function time(label: string, n: number, fn: () => unknown | Promise<unknown>): Promise<number> {
    await fn();                       // warm up one call
    const t0 = performance.now();
    for (let i = 0; i < n; i++) await fn();
    const ms = (performance.now() - t0) / n;
    console.log(`  ${label.padEnd(34)} ${ms.toFixed(2)} ms/op`);
    return ms;
}

// ---- ed25519: the opcert signature (and the KES leaf) ----
const secret = fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const msg = new TextEncoder().encode("gerolamino header bench");
const pk = noble.ed25519.getPublicKey(secret);
const sig = noble.ed25519.sign(msg, secret);
const canonical = noble.ed25519.verify(sig, msg, pk, { zip215: false });
if (!canonical) throw new Error("noble rejected its own signature");
if (!verifyEd25519Signature_sync(sig, msg, pk)) throw new Error("harmoniclabs rejected the noble signature");
console.log("ed25519: both implementations accept the same signature\n");

// ---- VRF draft-03 (ECVRF-ED25519-SHA512-Elligator2) ----
const vrfSecret = fromHex("c8b1a9953c4611296a827abf8c47804d7f8ac7e2b2b1b21b0f5b0c8f5f7b1b6b");
const vrfPk = noble.ed25519.getPublicKey(vrfSecret);
let vrfProof: Uint8Array | null = null;
let proveMs = NaN;
try {
    const t0 = performance.now();
    const generated = VrfProof03.generate(vrfSecret, vrfPk, msg);
    proveMs = performance.now() - t0;
    vrfProof = new Uint8Array(generated.toBytes());
} catch (e) {
    console.log(`  VRF prove unavailable in this API surface: ${(e as Error).message}`);
}

console.log(`n = ${N}\n`);
const edCurrent = await time("ed25519 verify (harmoniclabs)", N, () => verifyEd25519Signature_sync(sig, msg, pk));
const edNoble = await time("ed25519 verify (noble, RFC8032)", N, () => noble.ed25519.verify(sig, msg, pk, { zip215: false }));

if (vrfProof && vrfPk && vrfProof.length === 80) {
    const proof = VrfProof03.fromBytes(vrfProof);
    const verifyOk = proof.verify(vrfPk, msg);
    if (!verifyOk) throw new Error("VRF proof failed to verify");
    const vrfMs = await time("VRF draft-03 verify", N, () => proof.verify(vrfPk!, msg));
    const hashMs = await time("VRF toHash (output)", N, () => proof.toHash());
    console.log(`\n  per header (2 ed25519 + 1 VRF): current ${(edCurrent * 2 + vrfMs + hashMs).toFixed(1)} ms, noble ed25519 ${(edNoble * 2 + vrfMs + hashMs).toFixed(1)} ms`);
    if (Number.isFinite(proveMs)) console.log(`  (proof generation took ${proveMs.toFixed(1)} ms, one-off)`);
} else {
    console.log(`\n  per header (2 ed25519): current ${(edCurrent * 2).toFixed(1)} ms, noble ${(edNoble * 2).toFixed(1)} ms`);
    console.log("  VRF: no proof available from this API surface; skipped");
}

console.log(`\nsanity: noble sig ${hex(sig).slice(0, 16)}…, pk ${hex(pk).slice(0, 16)}… (both verified above)`);


// ---- real header: verifyHeaderCrypto on a Conway block from the preprod fixture ----
if (process.argv.includes("--header")) {
    const { preprodFixture } = await import("../test/lib/chunkReader");
    const { locateHeader } = await import("../src/node/chunkFormat");
    const { parseHeaderCrypto, verifyHeaderCrypto } = await import("../src/node/headerVerify");
    const { networkByMagic } = await import("../src/node/networks");
    const fx = preprodFixture();
    const net = networkByMagic(1)!;
    const l = locateHeader(fx.conway);
    const h = parseHeaderCrypto(fx.conway.subarray(l.headerOffset, l.headerOffset + l.headerSize), l.eraTag);
    console.log("\nreal Conway header (preprod fixture), opcert cache warm after the first call:");
    let last: any = null;
    for (let i = 0; i < Math.min(N, 5); i++) {
        last = verifyHeaderCrypto(h, fx.nonceEpoch310, net.slotsPerKESPeriod, net.maxKESEvolutions);
        console.log(`  run ${i + 1}: opcert ${last.ms.opcert.toFixed(1)} ms, KES ${last.ms.kes.toFixed(1)} ms, VRF ${last.ms.vrf.toFixed(1)} ms, total ${(last.ms.opcert + last.ms.kes + last.ms.vrf).toFixed(1)} ms`);
    }
    console.log(`  flags: opcert=${last.opcertOk} kes=${last.kesOk} vrf=${last.vrfOk}, detail=${JSON.stringify(last.detail)}`);
}
