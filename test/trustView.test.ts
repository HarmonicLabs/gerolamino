import { describe, expect, test } from "bun:test";
import { trustView, type TrustInput } from "../src/extension/trustView";

const honest: TrustInput = {
    cryptoOk: 400, cryptoBad: 0, leaderOk: 400, leaderBad: 0, bodyBad: 0, linkBad: 0, lightQuery: true, startMode: "tip",
    trust: {
        freshness: { status: "fresh", lagSlots: 30 },
        density: { status: "ok", ratio: 0.71, pools: 40, coveredSlots: 3600, windowSlots: 3600 },
    },
};
const row = (v: ReturnType<typeof trustView>, key: string) => v.rows.find((r) => r.key === key)!;

describe("phase 2: trust panel", () => {
    test("before any header: checking", () => {
        const v = trustView({ startMode: "tip", lightQuery: true });
        expect(v.verdict.tone).toBe("pending");
    });

    test("an honest single-peer tip start: verified blocks, freshness and density; nonce, stake, start and peers still trusted", () => {
        const v = trustView(honest);
        expect(row(v, "blocks").tone).toBe("verified");
        expect(row(v, "fresh").tone).toBe("verified");
        expect(row(v, "density").tone).toBe("verified");
        expect(row(v, "density").value).toBe("71% of the maximum, 40 pools");
        for (const k of ["anchor", "nonce", "stake", "peers"]) expect(row(v, k).tone).toBe("trusted");
        expect(v.verdict.label).toBe("Partly trusted");
        expect(v.verdict.detail).toContain("pool stake");
    });

    test("a stale tip or a sparse chain is a warning", () => {
        expect(trustView({ ...honest, trust: { ...honest.trust, freshness: { status: "stale", lagSlots: 2400 } } }).verdict.tone).toBe("warning");
        const sparse = trustView({ ...honest, trust: { ...honest.trust, density: { status: "low", ratio: 0.05, pools: 1, coveredSlots: 3600, windowSlots: 3600 } } });
        expect(sparse.verdict.tone).toBe("warning");
        expect(row(sparse, "density").value).toBe("5% of the maximum, 1 pools");
    });

    test("failed checks are a warning; a peer without the light query cannot be checked", () => {
        expect(trustView({ ...honest, leaderBad: 1 }).verdict.tone).toBe("warning");
        expect(row(trustView({ startMode: "tip", lightQuery: false }), "blocks").tone).toBe("warning");
    });

    test("with a Mithril start, certified stake, a confirmed nonce and agreeing peers: verified", () => {
        const v = trustView({ ...honest, startMode: "mithril", trust: {
            ...honest.trust,
            nonce: { source: "peer", pools: 37, peersAgreeing: 2, peersAsked: 2 },
            stake: { source: "mithril", epoch: 1459, mismatches: 0 },
            peers: { total: 2, agreeing: 2, disagreeing: 0, behind: 0 },
        } });
        expect(v.rows.every((r) => r.tone === "verified")).toBe(true);
        expect(v.verdict.label).toBe("Verified");
    });

    test("peers on another chain, or a peer lying about stake, is a warning", () => {
        expect(trustView({ ...honest, trust: { ...honest.trust, peers: { total: 3, agreeing: 2, disagreeing: 1, behind: 0 } } }).verdict.tone).toBe("warning");
        expect(trustView({ ...honest, trust: { ...honest.trust, stake: { source: "mithril", epoch: 1, mismatches: 3 } } }).verdict.tone).toBe("warning");
    });
});

describe("phase 4: nonce and stake rows", () => {
    test("a nonce confirmed by 30 pools stays verified when a peer gives another; with few pools it is a warning", () => {
        const confirmed = trustView({ ...honest, trust: { ...honest.trust, nonce: { source: "peer", pools: 30, peersAgreeing: 1, peersAsked: 2, peersDisagreeing: 1 } } });
        expect(row(confirmed, "nonce").tone).toBe("verified");
        expect(row(confirmed, "nonce").value).toContain("1 peer(s) give a wrong one");
        const early = trustView({ ...honest, trust: { ...honest.trust, nonce: { source: "peer", pools: 2, peersAgreeing: 1, peersAsked: 2, peersDisagreeing: 1 } } });
        expect(row(early, "nonce").tone).toBe("warning");
    });

    test("stake while the Mithril check runs, and when it is unavailable", () => {
        expect(row(trustView({ ...honest, trust: { ...honest.trust, stake: { source: "peer", checking: true } } }), "stake").value).toBe("from the peer; Mithril check running");
        const off = row(trustView({ ...honest, trust: { ...honest.trust, stake: { source: "peer", error: "HTTP 503" } } }), "stake");
        expect(off.tone).toBe("trusted");
        expect(off.tip).toContain("HTTP 503");
    });
});
