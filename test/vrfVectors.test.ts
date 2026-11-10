import { describe, expect, test } from "bun:test";
import { VrfProof03 } from "@harmoniclabs/crypto";
import { vrf03VerifyReference } from "../src/node/vrf";
import { vrf03VerifyNoble } from "../src/node/vrf03Noble";
import draft03 from "./fixtures/draft03-a4.json";
import rfc9381 from "./fixtures/rfc9381-b4.json";

/**
 * Published test vectors, not produced by our code, are the only evidence that a VRF implementation is
 * conformant rather than merely self-consistent.
 *
 * Two suites look almost identical and are NOT interchangeable:
 *   - draft-irtf-cfrg-vrf-03, Appendix A.4, "ECVRF-ED25519-SHA512-Elligator2" - suite 0x04 with the draft-03
 *     Elligator2 hash-to-curve. This is what Cardano headers use (libsodium crypto_vrf_ietfdraft03) and what
 *     @harmoniclabs/crypto's port implements.
 *   - RFC 9381, Appendix B.4, "ECVRF-EDWARDS25519-SHA512-ELL2" - the final RFC's own construction. Its
 *     vectors do NOT verify under a draft-03 implementation; that is asserted below so nobody "fixes" the
 *     code with the wrong document.
 *
 * Fixtures: test/fixtures/draft03-a4.json and test/fixtures/rfc9381-b4.json (source lines inside them).
 */
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
type Vector = { pk: string; alpha: string; pi: string; beta: string };

describe("draft-03 A.4 vectors (the suite Cardano uses)", () => {
    const vectors = (draft03 as any).vectors as Vector[];
    test(`${vectors.length} vectors: noble and the reference verify, and beta matches the draft`, () => {
        for (const v of vectors) {
            const pk = fromHex(v.pk), alpha = fromHex(v.alpha), pi = fromHex(v.pi);
            const fast = vrf03VerifyNoble(pk, alpha, pi);
            const slow = vrf03VerifyReference(pk, alpha, pi);
            expect(slow).not.toBe(null);
            expect(fast).not.toBe(null);
            expect(hex(slow!)).toBe(v.beta);
            expect(hex(fast!)).toBe(v.beta);
            // the library's own parser agrees with the draft's beta too
            expect(hex(new Uint8Array(VrfProof03.fromBytes(pi).toHash()))).toBe(v.beta);
        }
    }, 60_000);

    test("one flipped bit anywhere invalidates the vector in both implementations", () => {
        for (const v of vectors) {
            const pk = fromHex(v.pk), alpha = fromHex(v.alpha), pi = fromHex(v.pi);
            for (const at of [0, 32, 48]) {
                const bad = Uint8Array.from(pi);
                bad[at] = bad[at]! ^ 0x01;
                expect(vrf03VerifyNoble(pk, alpha, bad)).toBe(null);
                expect(vrf03VerifyReference(pk, alpha, bad)).toBe(null);
            }
            expect(vrf03VerifyNoble(pk, Uint8Array.from([...alpha, 0x00]), pi)).toBe(null);
        }
    }, 60_000);
});

describe("RFC 9381 B.4 vectors belong to a different suite and must not verify here", () => {
    test("all three published RFC vectors are rejected by both implementations", () => {
        const vectors = (rfc9381 as any).vectors as Vector[];
        expect(vectors.length).toBe(3);
        for (const v of vectors) {
            const pk = fromHex(v.pk), alpha = fromHex(v.alpha), pi = fromHex(v.pi);
            expect(vrf03VerifyNoble(pk, alpha, pi)).toBe(null);
            expect(vrf03VerifyReference(pk, alpha, pi)).toBe(null);
        }
    }, 60_000);
});
