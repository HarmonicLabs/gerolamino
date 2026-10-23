import { afterEach, describe, expect, test } from "bun:test";
import { emptyStats } from "../src/node/browserNode";
import type { ChainHeader, PeerChain } from "../src/node/crossCheck";
import { NodeRunner } from "../src/node/runner";

class RefuseWS extends EventTarget {
    binaryType = "arraybuffer";
    constructor(readonly url: string) { super(); setTimeout(() => this.dispatchEvent(new Event("error")), 1); }
    send() {}
    close() {}
}

function chain(fromSlot: number, n: number, fork?: number): ChainHeader[] {
    return Array.from({ length: n }, (_, i) => { const slot = fromSlot + 20 * i; return { slot, blockNo: 1000 + i, hash: fork != null && slot >= fork ? `b${slot}` : `a${slot}` }; });
}
const tipOf = (hs: ChainHeader[]) => ({ slot: hs[hs.length - 1]!.slot, blockNo: hs[hs.length - 1]!.blockNo, hash: hs[hs.length - 1]!.hash });

let runners: NodeRunner[] = [];
afterEach(async () => { for (const r of runners) await r.stop(); runners = []; });

/** A runner with a fake main node (its chain `main`) and fake watchers, its loop not started: tick() is driven by hand. */
function setup(main: ChainHeader[], peers: Array<Partial<PeerChain> & { url: string; headers: ChainHeader[] }>, state = "at-tip") {
    const r = new NodeRunner({ config: { relayUrl: "ws://a", network: "preview", startMode: "tip", extraRelays: peers.map((p) => p.url) }, WebSocketImpl: RefuseWS as unknown as typeof WebSocket });
    runners.push(r);
    const x = r as any;
    x.running = true;
    for (const h of main) r.mainLog.add(h);
    const fakeNode = (endpoint: string, extra: object = {}) => ({ stats: { ...emptyStats(endpoint), state, serverTip: main.length ? tipOf(main) : null, ...extra }, stop() {}, pendingTxs: () => [], recent: [], lastPoint: () => null });
    x.node = fakeNode("ws://a");
    const watch = (ps: typeof peers) => { x.watchers = ps.map((p) => ({ url: p.url, stop: async () => {}, chain: () => ({ connected: true, sharedHistory: true, tip: p.headers.length ? tipOf(p.headers) : null, ...p }) })); };
    watch(peers);
    return { r, x, fakeNode, watch };
}

describe("phase 3: failover between peers", () => {
    test("peers that agree: no switch, and the trust panel counts them", () => {
        const main = chain(10_000, 50);
        const { r } = setup(main, [{ url: "ws://b", headers: chain(10_000, 50) }, { url: "ws://c", headers: chain(10_000, 49) }]);
        r.tick(); r.tick(); r.tick();
        const s = r.stats();
        expect(r.settings.relayUrl).toBe("ws://a");
        expect(s.trust.peers).toMatchObject({ total: 3, agreeing: 3, disagreeing: 0, primary: "ws://a" });
        expect(s.peers.map((p) => p.verdict)).toEqual(["agree", "agree"]);
    });

    test("the main peer falls behind: after two checks the peer ahead becomes the main peer", () => {
        const { r } = setup(chain(10_000, 20), [{ url: "ws://b", headers: chain(10_000, 50) }]);
        r.tick();
        expect(r.settings.relayUrl).toBe("ws://a");
        r.tick();
        expect(r.settings.relayUrl).toBe("ws://b");
        expect(r.settings.extraRelays).toEqual(["ws://a"]);
        expect(r.stats().failovers[0]).toMatchObject({ from: "ws://a", to: "ws://b", reason: "the main peer fell behind" });
    });

    test("a longer fork: switch and roll back to the newest common block", () => {
        const { r, x } = setup(chain(10_000, 50), [{ url: "ws://b", headers: chain(10_000, 60, 10_500) }]);
        r.tick(); r.tick();
        expect(r.settings.relayUrl).toBe("ws://b");
        expect(x.rollbackTo).toEqual({ slot: 10_480, hash: "a10480" });
        expect(r.mainLog.last!.slot).toBe(10_480);
    });

    test("a shorter fork never wins; a peer is flagged as on another chain", () => {
        const { r } = setup(chain(10_000, 50), [{ url: "ws://b", headers: chain(10_000, 49, 10_500) }]);
        r.tick(); r.tick(); r.tick();
        expect(r.settings.relayUrl).toBe("ws://a");
        expect(r.stats().trust.peers).toMatchObject({ disagreeing: 1 });
    });

    test("main peer down: switch to a connected peer", () => {
        const { r } = setup(chain(10_000, 50), [{ url: "ws://b", headers: chain(10_000, 50) }], "error");
        r.tick(); r.tick();
        expect(r.settings.relayUrl).toBe("ws://b");
        expect(r.stats().failovers[0]!.reason).toBe("the main peer is down");
    });

    test("a new main peer serving an invalid header is dropped and the old one restored", () => {
        const { r, x, fakeNode, watch } = setup(chain(10_000, 20), [{ url: "ws://b", headers: chain(10_000, 50) }]);
        r.tick(); r.tick();
        expect(r.settings.relayUrl).toBe("ws://b");
        x.switching = false; // the run loop clears it when the new connection starts
        x.node = fakeNode("ws://b", { cryptoBad: 1, state: "syncing" });
        watch([{ url: "ws://a", headers: chain(10_000, 20) }]);
        r.tick();
        expect(r.settings.relayUrl).toBe("ws://a");
        expect(r.settings.extraRelays).toEqual([]);
        expect(r.stats().failovers.map((f) => f.to)).toEqual(["ws://b", "ws://a"]);
    });
});

describe("phase 3: a dropped peer stays dropped", () => {
    test("after the revert, the dropped peer is not switched to again even when it looks ahead", () => {
        const { r, x, fakeNode, watch } = setup(chain(10_000, 20), [{ url: "ws://b", headers: chain(10_000, 50) }]);
        r.tick(); r.tick();
        x.switching = false;
        x.node = fakeNode("ws://b", { cryptoBad: 1, state: "syncing" });
        r.tick();
        x.switching = false;
        x.node = fakeNode("ws://a");
        watch([{ url: "ws://b", headers: chain(10_000, 50) }]);
        r.tick(); r.tick(); r.tick();
        expect(r.settings.relayUrl).toBe("ws://a");
    });
});

describe("phase 3: a main peer that is busy is not down", () => {
    test("anchoring (a Mithril start), connecting or in the handshake never triggers a failover", () => {
        for (const state of ["anchoring", "connecting", "handshake"]) {
            const { r } = setup([], [{ url: "ws://b", headers: chain(10_000, 50) }], state);
            r.tick(); r.tick(); r.tick();
            expect(r.settings.relayUrl).toBe("ws://a");
        }
    });
});

describe("phase 3: tips during a Mithril start", () => {
    test("a main node still anchoring (its relay tip a stale probe) is not 'behind' a moving witness", () => {
        const { r } = setup(chain(10_000, 5), [{ url: "ws://b", headers: chain(10_000, 50) }], "anchoring");
        r.tick(); r.tick(); r.tick();
        expect(r.settings.relayUrl).toBe("ws://a");
        expect(r.stats().peers[0]!.verdict).not.toBe("ahead");
    });
});
