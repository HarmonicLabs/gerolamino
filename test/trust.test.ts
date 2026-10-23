import { describe, expect, test } from "bun:test";
import { networkByName, slotToUnix } from "../src/node/networks";
import { ChainObserver, DENSITY_WINDOW, freshness } from "../src/node/trust";

const preview = networkByName("preview")!;

/** A chain where each slot has a block with probability p, issued by one of `pools` pools (seeded, repeatable). */
function chain(fromSlot: number, slots: number, p: number, pools: number, seed = 1) {
    let x = seed;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const out: Array<{ slot: number; blockNo: number; hash: string; poolId: string }> = [];
    for (let s = fromSlot; s < fromSlot + slots; s++) {
        if (rnd() < p) out.push({ slot: s, blockNo: out.length, hash: `h${s}`, poolId: `pool${Math.floor(rnd() * pools)}` });
    }
    return out;
}

describe("phase 1: freshness", () => {
    const tip = 126_000_000;
    const at = (lag: number) => slotToUnix(preview, tip + lag) * 1000;
    test("fresh up to 5 minutes behind the wall clock, lagging up to 15, stale beyond", () => {
        expect(freshness(preview, tip, at(60)).status).toBe("fresh");
        expect(freshness(preview, tip, at(300)).status).toBe("fresh");
        expect(freshness(preview, tip, at(600)).status).toBe("lagging");
        expect(freshness(preview, tip, at(901)).status).toBe("stale");
        expect(freshness(preview, tip, at(901)).lagSlots).toBe(901);
        expect(freshness(preview, null).status).toBe("unknown");
    });
});

describe("phase 1: density", () => {
    test("an honest chain (0.7 f, many pools) is ok once the window is covered", () => {
        const o = new ChainObserver();
        o.begin(1_000);
        for (const h of chain(1_000, DENSITY_WINDOW + 200, 0.035, 60)) o.observe(h);
        const d = o.density();
        expect(d.status).toBe("ok");
        expect(d.ratio!).toBeGreaterThan(0.5);
        expect(d.ratio!).toBeLessThan(0.95);
        expect(d.pools).toBeGreaterThan(30);
    });

    test("a private fork by a small pool is far too sparse and has one issuer", () => {
        const o = new ChainObserver();
        o.begin(1_000);
        for (const h of chain(1_000, DENSITY_WINDOW + 200, 0.0025, 1)) o.observe(h);
        const d = o.density();
        expect(d.status).toBe("low");
        expect(d.ratio!).toBeLessThan(0.15);
        expect(d.pools).toBe(1);
    });

    test("insufficient until a full window of chain has been seen, with progress", () => {
        const o = new ChainObserver();
        expect(o.density().status).toBe("insufficient");
        for (const h of chain(1_000, 1_000, 0.035, 60)) o.observe(h);
        const d = o.density();
        expect(d.status).toBe("insufficient");
        expect(d.coveredSlots).toBeGreaterThan(900);
        expect(d.coveredSlots).toBeLessThan(DENSITY_WINDOW);
    });

    test("rollbacks remove headers; a header at or before the last one replaces the fork", () => {
        const o = new ChainObserver();
        o.begin(1_000);
        for (const h of chain(1_000, DENSITY_WINDOW + 200, 0.035, 60)) o.observe(h);
        const n = o.size;
        o.rollbackTo(1_000 + DENSITY_WINDOW);
        expect(o.size).toBeLessThan(n);
        expect(o.last!.slot).toBeLessThanOrEqual(1_000 + DENSITY_WINDOW);
        const before = o.last!.slot;
        o.observe({ slot: before, blockNo: 0, hash: "fork", poolId: "x" }); // same slot: the old header is dropped
        expect(o.last!.hash).toBe("fork");
        expect(o.poolsBetween(before, before)).toBe(1);
    });
});
