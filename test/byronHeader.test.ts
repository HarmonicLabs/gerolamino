import { describe, expect, test } from "bun:test";
import { Cbor } from "@harmoniclabs/cbor";
import fixture from "./fixtures/byron-preprod.json" with { type: "json" };
import { byronGenesisFor, byronHeaderHash, byronObftFor, parseByronChainSyncHeader, parseByronHeader } from "../src/node/byron";
import { summarizeHeader } from "../src/node/browserNode";

type HeaderFixture = { byronType: number; headerHex: string; hash: string; prevHash: string | null; rollForwardHex: string };
const headers = fixture.headers as HeaderFixture[];

describe("Byron header parser", () => {
    test("Byron header hash, parent and absolute slot (preprod fixture)", () => {
        for (const h of headers) {
            const raw = new Uint8Array(h.headerHex.match(/../g)!.map((x) => parseInt(x, 16)));
            const p = parseByronHeader(raw, h.byronType);
            expect(p.hash).toBe(h.hash);
            expect(p.prevHash).toBe(h.prevHash);
            expect(p.isEbb).toBe(h.byronType === 0);
            expect(byronHeaderHash(h.byronType, raw)).toBe(h.hash);
        }
    });

    test("Byron chain-sync wrapper parse, including the epoch-boundary block", () => {
        for (const h of headers) {
            const outer = Cbor.parse(new Uint8Array(h.rollForwardHex.match(/../g)!.map((x) => parseInt(x, 16)))) as any;
            const data = outer.array[1];
            const p = parseByronChainSyncHeader(data.array[1]);
            expect(p.hash).toBe(h.hash);
            expect(p.prevHash).toBe(h.prevHash);
        }
    });

    test("summarizeHeader accepts the Byron wrapper and keeps era 0/1", () => {
        for (const h of headers) {
            const outer = Cbor.parse(new Uint8Array(h.rollForwardHex.match(/../g)!.map((x) => parseInt(x, 16)))) as any;
            const summary = summarizeHeader(outer.array[1]);
            expect(summary.eraTag).toBe(h.byronType);
            expect(summary.hash).toBe(h.hash);
            expect(summary.isByron).toBe(true);
            expect(summary.isEbb).toBe(h.byronType === 0);
        }
    });

    test("preprod genesis delegation state and the real main-block signature", () => {
        const genesis = byronGenesisFor("preprod");
        expect(genesis).not.toBeNull();
        const state = byronObftFor("preprod")!;
        expect(state.delegationMap().size).toBe(7);
        for (const h of headers.filter((x) => x.byronType === 1)) {
            const raw = new Uint8Array(h.headerHex.match(/../g)!.map((x) => parseInt(x, 16)));
            const p = parseByronHeader(raw, h.byronType);
            const r = state.validateMainHeader(raw, BigInt(p.slot));
            expect(r.ok).toBe(true);
            state.noteAppliedIssuer(r.issuerKeyHash!, BigInt(p.slot));
        }
    });

    test("a tampered Byron main header fails its signature", () => {
        const h = headers.find((x) => x.byronType === 1)!;
        const raw = new Uint8Array(h.headerHex.match(/../g)!.map((x) => parseInt(x, 16)));
        const bad = raw.slice();
        bad[bad.length - 1] ^= 0x01;
        const state = byronObftFor("preprod")!;
        const p = parseByronHeader(raw, h.byronType);
        expect(state.validateMainHeader(bad, BigInt(p.slot)).ok).toBe(false);
    });
});
