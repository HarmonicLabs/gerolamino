import { describe, expect, test } from "bun:test";
import { locateHeader } from "../src/node/chunkFormat";
import { parseHeaderCrypto, verifyHeaderCrypto, verifyOpcert } from "../src/node/headerVerify";
import { networkByMagic } from "../src/node/networks";
import { preprodFixture } from "./lib/chunkReader";

const fx = preprodFixture();
const net = networkByMagic(1)!;
const header = (block: Uint8Array) => { const l = locateHeader(block); return parseHeaderCrypto(block.subarray(l.headerOffset, l.headerOffset + l.headerSize), l.eraTag); };

describe("header cryptography (opcert, KES, VRF) on @harmoniclabs/crypto + @harmoniclabs/kes", () => {
    test("Conway (Praos) header verifies with its epoch nonce; wrong nonce fails VRF; tampered body fails KES", () => {
        const h = header(fx.conway);
        const r = verifyHeaderCrypto(h, fx.nonceEpoch310, net.slotsPerKESPeriod, net.maxKESEvolutions);
        expect(r.detail).toEqual([]);
        expect([r.opcertOk, r.kesOk, r.vrfOk]).toEqual([true, true, true]);
        console.log(`  Conway header: opcert ${r.ms.opcert.toFixed(0)} ms, KES ${r.ms.kes.toFixed(0)} ms, VRF ${r.ms.vrf.toFixed(0)} ms`);
        expect(verifyHeaderCrypto(h, fx.nonceEpoch4, net.slotsPerKESPeriod, net.maxKESEvolutions).vrfOk).toBe(false);
        const body = Uint8Array.from(h.bodyBytes); body[body.length - 1]! ^= 1;
        expect(verifyHeaderCrypto({ ...h, bodyBytes: body }, fx.nonceEpoch310, net.slotsPerKESPeriod, net.maxKESEvolutions).kesOk).toBe(false);
    }, 30_000);

    test("Shelley (TPraos) header verifies (nonce and leader VRFs)", () => {
        const h = header(fx.shelley);
        expect(h.vrf).toBeNull();
        const r = verifyHeaderCrypto(h, fx.nonceEpoch4, net.slotsPerKESPeriod, net.maxKESEvolutions);
        expect(r.detail).toEqual([]);
        expect([r.opcertOk, r.kesOk, r.vrfOk]).toEqual([true, true, true]);
    }, 30_000);

    test("a forged operational certificate fails, and the opcert cache only remembers successes", () => {
        const h = header(fx.conway);
        const forged = { ...h, opcert: { ...h.opcert, counter: h.opcert.counter + 1n } };
        expect(verifyOpcert(forged)).toBe(false);
        expect(verifyOpcert(forged)).toBe(false);
        expect(verifyOpcert(h)).toBe(true);
        const t0 = performance.now(); expect(verifyOpcert(h)).toBe(true); expect(performance.now() - t0).toBeLessThan(5);
    }, 30_000);

    test("an expired or not-yet-valid KES period is reported", () => {
        const h = header(fx.conway);
        const early = verifyHeaderCrypto({ ...h, opcert: { ...h.opcert, kesPeriod: BigInt(Math.floor(h.slot / net.slotsPerKESPeriod) + 1) } }, fx.nonceEpoch310, net.slotsPerKESPeriod, net.maxKESEvolutions);
        expect(early.kesOk).toBe(false);
        expect(early.detail.join()).toContain("before the opcert");
        const late = verifyHeaderCrypto({ ...h, opcert: { ...h.opcert, kesPeriod: 0n } }, fx.nonceEpoch310, net.slotsPerKESPeriod, net.maxKESEvolutions);
        expect(late.kesOk).toBe(false);
        expect(late.detail.join()).toContain("expired");
    }, 30_000);
});
