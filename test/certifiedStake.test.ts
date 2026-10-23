import { describe, expect, test } from "bun:test";
import { emptyStats } from "../src/node/browserNode";
import type { CertifiedStake } from "../src/node/mithrilLoader";
import { NodeRunner } from "../src/node/runner";

const cs = (epoch: number): CertifiedStake => ({ leaderEpoch: epoch, artifactEpoch: epoch - 2, certificateHash: "c".repeat(64), pools: new Map([["ab".repeat(28), 5n]]), total: 10n, certificatesWalked: 3, ms: 1 });

describe("phase 4: certified stake in the runner", () => {
    test("fetched once per epoch in the background; the trust panel follows it", async () => {
        let calls = 0;
        const r = new NodeRunner({ config: { relayUrl: "ws://a", network: "preview", startMode: "tip", certifiedStake: true }, loadMithrilStake: async () => async ({ epoch }) => { calls++; await Bun.sleep(20); return cs(epoch); } });
        const x = r as any;
        x.node = { stats: { ...emptyStats("ws://a"), lastSlot: 1459 * 86_400 + 5 }, pendingTxs: () => [], recent: [] };
        expect(x.certifiedStakeOf(1459)).toBeNull();
        expect(r.stats().trust.stake).toMatchObject({ source: "peer", epoch: 1459, checking: true });
        expect(x.certifiedStakeOf(1459)).toBeNull(); // still in flight: not asked twice
        await Bun.sleep(50);
        expect(calls).toBe(1);
        expect(x.certifiedStakeOf(1459)?.total).toBe(10n);
        expect(r.stats().trust.stake).toMatchObject({ source: "mithril", epoch: 1459, artifactEpoch: 1457, mismatches: 0 });
    });

    test("a failure falls back to the peer's stake and says why; off by default", async () => {
        const r = new NodeRunner({ config: { relayUrl: "ws://a", network: "preview", startMode: "tip", certifiedStake: true }, loadMithrilStake: async () => async () => { throw new Error("HTTP 503"); } });
        const x = r as any;
        x.node = { stats: { ...emptyStats("ws://a"), lastSlot: 1459 * 86_400 }, pendingTxs: () => [], recent: [] };
        x.certifiedStakeOf(1459);
        await Bun.sleep(10);
        expect(r.stats().trust.stake).toMatchObject({ source: "peer", checking: false, error: "HTTP 503" });
        expect(x.certifiedStakeOf(1459)).toBeNull(); // not retried for 5 minutes
        const off = new NodeRunner({ config: { relayUrl: "ws://a", network: "preview", startMode: "tip" } }) as any;
        expect(off.certifiedStakeOf(1459)).toBeNull();
        expect(off.certified.size).toBe(0);
    });
});
