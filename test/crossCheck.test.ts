import { describe, expect, test } from "bun:test";
import { checkPeer, summarize, type ChainHeader } from "../src/node/crossCheck";

/** A chain of blocks every 20 slots from `fromSlot`; `fork` changes hashes from that slot on. */
function chain(fromSlot: number, n: number, opts: { fork?: number; firstBlockNo?: number; tag?: string } = {}): ChainHeader[] {
    return Array.from({ length: n }, (_, i) => {
        const slot = fromSlot + 20 * i;
        return { slot, blockNo: (opts.firstBlockNo ?? 1000) + i, hash: opts.fork != null && slot >= opts.fork ? `${opts.tag ?? "b"}${slot}` : `a${slot}` };
    });
}
const tipOf = (hs: ChainHeader[]) => ({ slot: hs[hs.length - 1]!.slot, blockNo: hs[hs.length - 1]!.blockNo });
const peer = (url: string, headers: ChainHeader[], extra: Partial<Parameters<typeof checkPeer>[1]> = {}) =>
    ({ url, connected: true, sharedHistory: true, headers, tip: headers.length ? tipOf(headers) : null, ...extra });

describe("phase 3: cross-checking peers", () => {
    const main = chain(10_000, 50);
    const m = { headers: main, tip: tipOf(main) };

    test("a peer serving the same chain agrees, even when a little behind on the newest blocks", () => {
        expect(checkPeer(m, peer("ws://b", chain(10_000, 48))).verdict).toBe("agree");
        expect(checkPeer(m, peer("ws://b", chain(10_400, 30))).verdict).toBe("agree"); // joined later
    });

    test("a different block at a settled slot is a fork; the longer one is marked", () => {
        const forked = chain(10_000, 55, { fork: 10_500 });
        const c = checkPeer(m, peer("ws://b", forked));
        expect(c.verdict).toBe("fork");
        expect(c.detail).toBe("differs at slot 10500");
        expect(c.longer).toBe(true);
        expect(checkPeer(m, peer("ws://b", chain(10_000, 48, { fork: 10_500 }))).longer).toBe(false);
    });

    test("a block the peer is missing (withheld) is a disagreement too", () => {
        const withheld = chain(10_000, 50).filter((h) => h.slot !== 10_600);
        expect(checkPeer(m, peer("ws://b", withheld)).verdict).toBe("fork");
    });

    test("a stale peer is behind; when another peer is ahead, the main peer is the stale one", () => {
        expect(checkPeer(m, peer("ws://b", chain(10_000, 20))).verdict).toBe("behind");
        const ahead = checkPeer({ headers: chain(10_000, 20), tip: tipOf(chain(10_000, 20)) }, peer("ws://b", main));
        expect(ahead.verdict).toBe("ahead");
        expect(summarize([ahead]).switchTo).toBe("ws://b");
    });

    test("no shared history is a fork; a disconnected peer is down; too little overlap is pending", () => {
        expect(checkPeer(m, peer("ws://b", chain(10_000, 50, { fork: 0, tag: "z" }), { sharedHistory: false })).verdict).toBe("fork");
        expect(checkPeer(m, peer("ws://b", [], { connected: false })).verdict).toBe("down");
        expect(checkPeer(m, peer("ws://b", chain(10_960, 3))).verdict).toBe("pending");
    });

    test("summary: the main peer agrees with itself; a longer fork is where to switch", () => {
        const s = summarize([
            checkPeer(m, peer("ws://agree", chain(10_000, 50))),
            checkPeer(m, peer("ws://fork", chain(10_000, 55, { fork: 10_500 }))),
            checkPeer(m, peer("ws://down", [], { connected: false })),
        ]);
        expect(s).toEqual({ total: 4, agreeing: 2, disagreeing: 1, behind: 0, down: 1, switchTo: "ws://fork" });
    });
});

describe("phase 3: fork details and the header log", () => {
    const main = chain(10_000, 50);
    test("a fork reports the newest common header, also when the forked peer is far ahead", () => {
        const c = checkPeer({ headers: main, tip: tipOf(main) }, peer("ws://b", chain(10_000, 80, { fork: 10_500 })));
        expect(c.verdict).toBe("fork");
        expect(c.common).toEqual({ slot: 10_480, blockNo: 1024, hash: "a10480" });
    });

    test("a longer fork with no shared history is reported but never switched to", () => {
        const c = checkPeer({ headers: main, tip: tipOf(main) }, { url: "ws://b", connected: true, sharedHistory: false, headers: [], tip: { slot: 20_000, blockNo: 5000 } });
        expect(c.verdict).toBe("fork");
        expect(summarize([c]).switchTo).toBeNull();
    });

    test("the log drops old headers, replaces a fork and samples newest first", async () => {
        const { HeaderLog } = await import("../src/node/crossCheck");
        const log = new HeaderLog(1000);
        for (const h of chain(10_000, 100)) log.add(h);
        expect(log.headers[0]!.slot).toBeGreaterThanOrEqual(log.last!.slot - 1000);
        log.add({ slot: 11_900, blockNo: 1, hash: "x" });
        expect(log.last!.hash).toBe("x");
        expect(log.headers.filter((h) => h.slot > 11_900)).toHaveLength(0);
        const s = log.sample(3, 10);
        expect(s.map((h) => h.slot)).toEqual([11_900, 11_700, 11_500]);
    });
});
