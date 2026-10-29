/**
 * Peer-backed Blockfrost queries: the main relay first, then the extra Gerolamo peers (watchers) that speak the
 * light query and either announce `blockfrost` or predate the announcement (version 0). A peer that announces
 * capabilities without blockfrost is never asked; a peer that fails (timeout, connection closed, unsupported,
 * 5xx) yields to the next one; the answer names the peer that actually answered.
 *
 * Rate limits are per peer, from its announcement (`blockfrost.rate` per `window_ms`): a peer that would exceed
 * its own limit is skipped without counting against the others. No candidate at all gives a 503 with the list
 * of peers tried, in Blockfrost's error shape.
 */
export interface PeerQueryLimits { rate: number; windowMs: number; maxBody: number }

export interface QueryCandidate {
    url: string;
    /** The peer's announced blockfrost limits; null for a version-0 peer (unknown, probe it). */
    limits: PeerQueryLimits | null;
    query(path: string, timeoutMs?: number): Promise<{ status: number; body: string }>;
}

export interface RoutedAnswer {
    status: number;
    body: string;
    /** The peer that answered ("" when none did). */
    peer: string;
}

export interface QueryRouterOptions {
    /** Per-candidate timeout (default 10 s; failover should be quick). */
    timeoutMs?: number;
    now?: () => number;
}

/** A peer with an announcement that lacks blockfrost cannot answer; a version-0 peer is worth probing. */
export function isBlockfrostCapable(capabilities: { blockfrost: unknown } | null): boolean {
    return capabilities === null || capabilities.blockfrost != null;
}

export class QueryRouter {
    private readonly calls = new Map<string, number[]>();
    private readonly skipped = new Set<string>();

    constructor(private readonly candidates: () => QueryCandidate[], private readonly opts: QueryRouterOptions = {}) {}

    get timeoutMs(): number { return this.opts.timeoutMs ?? 10_000; }
    private now(): number { return (this.opts.now ?? Date.now)(); }

    /** Peers a query may ask, in the runner's order (main relay first, then watchers). */
    private ordered(): QueryCandidate[] {
        return this.candidates().filter((c) => c.url);
    }

    async query(path: string): Promise<RoutedAnswer> {
        const tried: string[] = [];
        let lastResult: RoutedAnswer | null = null;
        for (const c of this.ordered()) {
            if (this.limited(c)) continue;
            tried.push(c.url);
            try {
                const r = await c.query(path, this.timeoutMs);
                if (r.status < 500) return { status: r.status, body: r.body, peer: c.url };
                lastResult = { status: r.status, body: r.body, peer: c.url };
            } catch (e) {
                this.skipped.add(`${c.url}|${(e as Error).message}`);
            }
        }
        if (lastResult) return lastResult;
        return {
            status: 503,
            body: JSON.stringify({
                status_code: 503, error: "Service Unavailable",
                message: tried.length ? `no Gerolamo peer answered ${path} (tried ${tried.join(", ")})` : `no Gerolamo peer that answers queries is connected (${path})`,
            }),
            peer: "",
        };
    }

    /** Per-peer announced rate limit: skip this candidate (not the query) when it would exceed rate per window. */
    private limited(c: QueryCandidate): boolean {
        if (!c.limits || c.limits.rate <= 0 || c.limits.windowMs <= 0) return false;
        const now = this.now();
        const times = (this.calls.get(c.url) ?? []).filter((t) => now - t < c.limits!.windowMs);
        if (times.length >= c.limits.rate) { this.calls.set(c.url, times); return true; }
        times.push(now);
        this.calls.set(c.url, times);
        return false;
    }

    /** Candidates as the runner sees them now (diagnostics; the popup/Trust card uses peer rows). */
    peers(): string[] { return this.ordered().map((c) => c.url); }
    /** Errors seen while failing over, per peer|message (diagnostics only). */
    failures(): string[] { return [...this.skipped]; }
}
