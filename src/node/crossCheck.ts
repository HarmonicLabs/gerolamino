/**
 * Cross-checking peers (pure, unit tested). The main peer's chain is compared with what each extra peer serves:
 * the same headers over the settled part of their overlap (older than SETTLE_SLOTS, so ordinary delivery delays
 * do not count), and tips that keep pace. A peer that withholds blocks, serves a stale chain or a different fork shows
 * up here, including the main peer itself (another peer is ahead of it). Forks are decided by chain length, the
 * higher block number, as Praos does.
 */
export interface ChainHeader { slot: number; blockNo: number; hash: string }
export interface Tip { slot: number; blockNo: number }

export interface PeerChain {
    url: string;
    connected: boolean;
    /** The peer's chain-sync intersected at a point of the main chain (false: it shares none of the sampled points). */
    sharedHistory: boolean | null;
    headers: ChainHeader[];
    tip: Tip | null;
}

/** agree: same chain; fork: another chain; behind: keeps a stale tip; ahead: the main peer is behind it. */
export type PeerVerdict = "agree" | "fork" | "behind" | "ahead" | "pending" | "down";
export interface PeerCheck {
    url: string;
    verdict: PeerVerdict;
    tip: Tip | null;
    detail: string;
    /** fork: the peer's chain is longer than the main peer's. */
    longer?: boolean;
    /** fork: the newest header both chains hold (where the main chain would roll back to). */
    common?: ChainHeader | null;
}

export const SETTLE_SLOTS = 60;
export const LAG_BLOCKS = 3;
export const LAG_SLOTS = 120;
/** Settled headers that must match before a peer counts as agreeing (one shared block is thin evidence). */
export const MIN_AGREE = 3;
/** Headers kept per chain: two hours of slots, enough for the overlap and the 1 h density window. */
export const LOG_SLOTS = 7200;

export function checkPeer(main: { headers: ChainHeader[]; tip: Tip | null }, peer: PeerChain): PeerCheck {
    const base = { url: peer.url, tip: peer.tip };
    if (!peer.connected) return { ...base, verdict: "down", detail: "not connected" };
    const mt = main.tip, pt = peer.tip;
    const longer = !!(mt && pt && pt.blockNo > mt.blockNo);

    // 1. the settled overlap: any header that differs (or is missing on one side) is a fork
    const mh = main.headers, ph = peer.headers;
    let compared = -1;
    if (mh.length && ph.length) {
        const from = Math.max(mh[0]!.slot, ph[0]!.slot);
        const to = Math.min(mh[mh.length - 1]!.slot, ph[ph.length - 1]!.slot) - SETTLE_SLOTS;
        if (to > from) {
            const pick = (hs: ChainHeader[]) => new Map(hs.filter((h) => h.slot > from && h.slot <= to).map((h) => [h.slot, h]));
            const a = pick(mh), b = pick(ph);
            let common: ChainHeader | null = null;
            for (const slot of [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y)) {
                if (a.get(slot)?.hash !== b.get(slot)?.hash) return { ...base, verdict: "fork", detail: `differs at slot ${slot}`, longer, common };
                common = a.get(slot)!;
            }
            compared = a.size;
        }
    }
    if (peer.sharedHistory === false) return { ...base, verdict: "fork", detail: "shares none of the main chain's recent blocks", longer, common: null };

    // 2. tips that keep pace
    if (mt && pt) {
        if (pt.blockNo + LAG_BLOCKS < mt.blockNo && pt.slot + LAG_SLOTS < mt.slot) return { ...base, verdict: "behind", detail: `${mt.blockNo - pt.blockNo} blocks behind` };
        if (mt.blockNo + LAG_BLOCKS < pt.blockNo && mt.slot + LAG_SLOTS < pt.slot) return { ...base, verdict: "ahead", detail: `the main peer is ${pt.blockNo - mt.blockNo} blocks behind it` };
    }
    if (compared < MIN_AGREE) return { ...base, verdict: "pending", detail: mh.length && ph.length ? `${Math.max(0, compared)} of ${MIN_AGREE} settled headers compared` : "waiting for headers" };
    return { ...base, verdict: "agree", detail: `${compared} settled headers match` };
}

export interface PeersSummary {
    total: number;
    agreeing: number;
    disagreeing: number;
    behind: number;
    down: number;
    /** A peer the main peer should be replaced by: it is ahead on the same chain, or on a longer fork that shares history. */
    switchTo: string | null;
}

/** The main peer counts as agreeing with itself. */
export function summarize(checks: PeerCheck[]): PeersSummary {
    const n = (v: PeerVerdict) => checks.filter((c) => c.verdict === v).length;
    const better = checks.find((c) => c.verdict === "ahead") ?? checks.find((c) => c.verdict === "fork" && c.longer && c.common);
    return { total: 1 + checks.length, agreeing: 1 + n("agree"), disagreeing: n("fork"), behind: n("behind"), down: n("down"), switchTo: better?.url ?? null };
}

/** The recent headers of one chain, in chain order, rollback-aware. */
export class HeaderLog {
    private hs: ChainHeader[] = [];
    constructor(readonly keepSlots = LOG_SLOTS) {}
    get headers(): ChainHeader[] { return this.hs; }
    get last(): ChainHeader | null { return this.hs[this.hs.length - 1] ?? null; }
    add(h: ChainHeader): void {
        if (this.last && h.slot <= this.last.slot) this.rollbackTo(h.slot - 1);
        this.hs.push(h);
        let drop = 0;
        while (drop < this.hs.length && this.hs[drop]!.slot < h.slot - this.keepSlots) drop++;
        if (drop) this.hs.splice(0, drop);
    }
    rollbackTo(slot: number): void { while (this.hs.length && this.hs[this.hs.length - 1]!.slot > slot) this.hs.pop(); }
    clear(): void { this.hs = []; }
    /** Points to intersect another peer at: the newest header (at or before `maxSlot`), then every `step`-th older one. */
    sample(max = 20, step = 10, maxSlot = Infinity): ChainHeader[] {
        const out: ChainHeader[] = [];
        let i = this.hs.length - 1;
        while (i >= 0 && this.hs[i]!.slot > maxSlot) i--;
        for (; i >= 0 && out.length < max; i -= step) out.push(this.hs[i]!);
        return out;
    }
}
