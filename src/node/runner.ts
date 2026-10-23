/**
 * Keeps a node running: one `BrowserNode` per connection, reconnecting with exponential backoff
 * (1 s doubling to 60 s, with jitter; reset once a connection reaches chain-sync). Each new connection
 * resumes from the stored tip, or from the last verified point when there is no store. Counters are
 * accumulated across connections so the popup shows totals for the session.
 *
 * Extra relays are watched headers-only (peerWatch.ts) and cross-checked against the main peer every
 * CHECK_MS (crossCheck.ts). When the main peer is behind another peer, on a shorter fork that shares history,
 * or down, for SWITCH_TICKS checks in a row, that peer becomes the main peer (on a fork the store is rolled back
 * to the newest common block first). A new main peer that then serves a header failing its checks is dropped
 * for the session and the previous one restored.
 */
import { BrowserNode, emptyStats, type NodeStats, type Point, type StartMode } from "./browserNode";
import type { FileSink } from "./chunkWriter";
import { loadMithrilStake, loadMithrilTxProof, type CertifiedStake, type MithrilAnchorFn, type MithrilStakeFn, type MithrilTxProofFn } from "./mithrilLoader";
import { checkTxAnswer, txHashOfPath, type TxProofCheck } from "./txProofCheck";
import { epochOfSlot, firstSlotOfEpoch, networkByName } from "./networks";
import { LocalChainIndex, loadIndexFromStore } from "./localIndex";
import { ChainObserver, freshness, type Density, type Freshness } from "./trust";
import { answerQuery, normalizePath, type QueryAnswer } from "./query";
import { QueryUnsupported } from "./lightQuery";
import type { QueuedTx } from "./txSubmit";
import { checkPeer, HeaderLog, summarize, type ChainHeader, type PeerCheck, type PeersSummary } from "./crossCheck";
import { PeerWatcher } from "./peerWatch";
import { toHex } from "@harmoniclabs/uint8array-utils";

export interface RunnerConfig {
    relayUrl: string;
    network: "preview" | "preprod" | "mainnet";
    startMode: "tip" | "mithril" | "chunk";
    /** More relays, watched headers-only and cross-checked against the main one. */
    extraRelays?: string[];
    /** Check the leader stake against Mithril's certified stake distribution (fetched from the aggregator). */
    certifiedStake?: boolean;
    /** Check relayed answers about a transaction against a Mithril proof that it is on the chain. */
    txProofs?: boolean;
}

/** A query answer, with the Mithril check of a relayed answer about a transaction. */
export type CheckedAnswer = QueryAnswer & { proof?: TxProofCheck };

/** How long a query waits for the Mithril check (a first check may walk the whole certificate chain; it goes on in the background). */
const PROOF_WAIT_MS = 20_000;

export interface RunnerStats extends NodeStats {
    running: boolean;
    network: string;
    connects: number;
    /** Wall-clock time of the next connection attempt while backing off. */
    nextRetryAt: number | null;
    backoffMs: number;
    pendingTxs: QueuedTx[];
    recent: Array<{ slot: number; blockNo: number; hash: string; size: number; txs: number }>;
    /** Stored blocks in the local query index. */
    indexedBlocks: number;
    /** Can the chain be trusted: the peer's tip against the wall clock, and the chain's density (trust.ts). */
    trust: {
        freshness: Freshness | null; density: Density; peers: (PeersSummary & { primary: string }) | null;
        /** The current epoch's nonce: how many pools' VRF proofs verified with it, and whether other peers give the same. */
        nonce: { source: "peer"; epoch: number; pools: number; peersAgreeing: number; peersAsked: number; peersDisagreeing: number } | null;
        /** Where the leader stake comes from: Mithril-certified, or the peer (while the check runs, or without it). */
        stake: { source: "mithril" | "peer"; epoch: number; artifactEpoch?: number; certificate?: string; mismatches: number; checking: boolean; error?: string } | null;
    };
    /** The extra relays' cross-check (empty without extra relays). */
    peers: PeerCheck[];
    /** Main-peer switches this session, newest last. */
    failovers: Array<{ at: number; from: string; to: string; reason: string }>;
}

export interface RunnerOptions {
    config: RunnerConfig;
    /** A store for the network (OPFS in the extension); undefined runs without persistence. */
    sinkFor?: (network: string) => FileSink | undefined;
    loadMithril?: () => Promise<MithrilAnchorFn | null>;
    /** Supplies the certified-stake function (default: dynamic import of the Mithril verifier). */
    loadMithrilStake?: () => Promise<MithrilStakeFn | null>;
    loadMithrilTxProof?: () => Promise<MithrilTxProofFn | null>;
    WebSocketImpl?: typeof WebSocket;
    log?: (line: string) => void;
    onStats?: (s: RunnerStats) => void;
    /** Backoff bounds (tests shorten them). */
    minBackoffMs?: number;
    maxBackoffMs?: number;
    /** Cross-check period (tests shorten it). */
    checkMs?: number;
}

export const CHECK_MS = 10_000;
export const SWITCH_TICKS = 2;
/** Headers a new main peer must serve cleanly before the switch counts as good. */
const PROBATION_HEADERS = 20;

/** Counters summed over connections. */
const COUNTERS = ["headers", "linkOk", "linkBad", "blocksFetched", "bodyOk", "bodyBad", "rollbacks", "rolledBackBlocks", "cryptoOk", "cryptoBad", "cryptoSkipped", "cryptoMs", "leaderOk", "leaderBad", "leaderSkipped", "stakeCertified", "stakeMismatches", "bytes"] as const;
type Counter = typeof COUNTERS[number];

export function nextBackoff(current: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, current * 2));
}

export class NodeRunner {
    private node: BrowserNode | null = null;
    private running = false;
    private config: RunnerConfig;
    private totals: Record<Counter, number> = Object.fromEntries(COUNTERS.map((k) => [k, 0])) as Record<Counter, number>;
    private connects = 0;
    private backoffMs: number;
    private nextRetryAt: number | null = null;
    private wake: (() => void) | null = null;
    private lastPoint: Point | null = null;
    private last: NodeStats;
    private loop: Promise<void> | null = null;
    private errors: string[] = [];
    /** Stored blocks indexed for local queries; kept across reconnects, rebuilt from the store per network. */
    readonly index = new LocalChainIndex();
    /** Verified headers for freshness and density; kept across reconnects, reset per network. */
    readonly observer = new ChainObserver();
    private indexNetwork: string | null = null;
    /** The main peer's recent headers (every header, hash and link checked), for the cross-check. */
    readonly mainLog = new HeaderLog();
    private watchers: PeerWatcher[] = [];
    private checks: PeerCheck[] = [];
    private summary: PeersSummary | null = null;
    private ticker: ReturnType<typeof setInterval> | null = null;
    private candidate: { url: string; ticks: number } | null = null;
    private downTicks = 0;
    private switching = false;
    private rollbackTo: Point | null = null;
    private probation: { from: string; to: string } | null = null;
    private readonly dropped = new Set<string>();
    private readonly failovers: RunnerStats["failovers"] = [];
    /** Certified stake per leader epoch: the distribution, a check in flight, or the time and reason it failed. */
    private readonly certified = new Map<number, CertifiedStake | { pending: true } | { failedAt: number; error: string }>();
    /** Nonces other peers give, per peer and epoch (hex; null: the peer has none). */
    private readonly peerNonces = new Map<string, string | null>();
    /** Mithril proofs in flight, per transaction: a repeated query waits for the same one. */
    private readonly proofs = new Map<string, Promise<Awaited<ReturnType<MithrilTxProofFn>>>>();

    constructor(private readonly opts: RunnerOptions) {
        this.config = { ...opts.config };
        this.backoffMs = opts.minBackoffMs ?? 1000;
        this.last = emptyStats(this.config.relayUrl);
    }

    get settings(): RunnerConfig { return { ...this.config }; }

    stats(): RunnerStats {
        const s: NodeStats = this.node ? { ...this.node.stats } : { ...this.last };
        for (const k of COUNTERS) (s as any)[k] = this.totals[k] + (this.node ? (this.node.stats as any)[k] : 0);
        s.errors = [...this.errors, ...(this.node?.stats.errors ?? [])].slice(-20);
        const net = networkByName(this.config.network);
        return {
            ...s, running: this.running, network: this.config.network, connects: this.connects,
            nextRetryAt: this.nextRetryAt, backoffMs: this.backoffMs, pendingTxs: this.node?.pendingTxs() ?? [],
            recent: this.node ? this.node.recent.slice(-12).reverse() : [],
            indexedBlocks: this.index.size,
            trust: {
                freshness: net ? freshness(net, s.serverTip?.slot ?? null) : null, density: this.observer.density(),
                nonce: this.nonceTrust(s), stake: this.stakeTrust(s),
                peers: this.summary ? { ...this.summary, primary: this.config.relayUrl } : null,
            },
            peers: this.checks, failovers: [...this.failovers],
        };
    }

    private nonceTrust(s: NodeStats): RunnerStats["trust"]["nonce"] {
        const net = networkByName(this.config.network);
        if (!net || s.nonceEpoch == null || !s.nonceHex) return null;
        const e = s.nonceEpoch;
        const pools = this.observer.poolsBetween(firstSlotOfEpoch(net, e), firstSlotOfEpoch(net, e + 1) - 1);
        const answers = this.watchers.map((w) => this.peerNonces.get(`${w.url}|${e}`)).filter((v): v is string => typeof v === "string");
        const agree = answers.filter((n) => n === s.nonceHex).length;
        return { source: "peer", epoch: e, pools, peersAgreeing: 1 + agree, peersAsked: 1 + answers.length, peersDisagreeing: answers.length - agree };
    }

    private stakeTrust(s: NodeStats): RunnerStats["trust"]["stake"] {
        const net = networkByName(this.config.network);
        const slot = s.lastSlot ?? s.serverTip?.slot;
        if (!net || slot == null || !this.config.certifiedStake) return null;
        const epoch = epochOfSlot(net, slot);
        const c = this.certified.get(epoch);
        if (c && "pools" in c) return { source: "mithril", epoch, artifactEpoch: c.artifactEpoch, certificate: c.certificateHash, mismatches: s.stakeMismatches, checking: false };
        return { source: "peer", epoch, mismatches: 0, checking: !!c && "pending" in c, error: c && "error" in c ? c.error : undefined };
    }

    /** The certified stake of an epoch if it is here; otherwise start fetching it (retried 5 min after a failure). */
    private certifiedStakeOf(epoch: number): CertifiedStake | null {
        if (!this.config.certifiedStake) return null;
        const c = this.certified.get(epoch);
        if (c && "pools" in c) return c;
        if (c && ("pending" in c || Date.now() - c.failedAt < 300_000)) return null;
        this.certified.set(epoch, { pending: true });
        const network = this.config.network;
        void (async () => {
            try {
                const fn = await (this.opts.loadMithrilStake ?? (() => loadMithrilStake()))();
                if (!fn) throw new Error("this build has no Mithril verifier");
                const cs = await fn({ network, epoch, log: (l) => this.log(l) });
                if (this.config.network === network) this.certified.set(epoch, cs);
                for (const k of this.certified.keys()) if (k < epoch - 1) this.certified.delete(k);
            } catch (e) {
                this.certified.set(epoch, { failedAt: Date.now(), error: (e as Error).message });
                this.log(`Mithril stake for epoch ${epoch}: ${(e as Error).message}; using the peer's stake`);
            }
            this.emit();
        })();
        return null;
    }

    private emit(): void { this.opts.onStats?.(this.stats()); }
    private log(l: string): void { this.opts.log?.(l); }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.loop = this.run();
        this.startWatchers();
        this.ticker = setInterval(() => this.tick(), this.opts.checkMs ?? CHECK_MS);
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = null;
        this.node?.stop();
        this.wake?.();
        await Promise.all([this.loop, ...this.watchers.map((w) => w.stop())]);
        this.watchers = []; this.checks = []; this.summary = null; this.candidate = null; this.downTicks = 0;
        this.loop = null;
        this.emit();
    }

    /** Apply new settings: stop the current connection and start again (store per network). */
    async restart(config: RunnerConfig): Promise<void> {
        // a new network or start mode means a new start point; a new relay URL keeps following the same chain
        const newStart = config.network !== this.config.network || config.startMode !== this.config.startMode;
        await this.stop();
        this.config = { ...config };
        if (newStart) { this.lastPoint = null; this.mainLog.clear(); this.dropped.clear(); this.probation = null; this.certified.clear(); this.peerNonces.clear(); }
        this.backoffMs = this.opts.minBackoffMs ?? 1000;
        this.start();
    }

    /** A Blockfrost-shaped query: answered from the local index when it can be, else by the connected Gerolamo peer. */
    async query(path: string): Promise<CheckedAnswer> {
        const net = networkByName(this.config.network);
        if (!net) throw new Error(`unknown network ${this.config.network}`);
        const node = this.node;
        const relay = node ? async (p: string) => {
            try { return await node.relayQuery(p); }
            catch (e) {
                const msg = e instanceof QueryUnsupported ? "this Gerolamo peer is too old to answer queries" : (e as Error).message;
                return { status: 502, body: JSON.stringify({ status_code: 502, error: "Bad Gateway", message: msg }) };
            }
        } : undefined;
        const answer: CheckedAnswer = await answerQuery(path, { index: this.index, network: net, relay, peer: this.config.relayUrl });
        const tx = txHashOfPath(normalizePath(path));
        if (tx && answer.source === "relay" && answer.status === 200 && this.config.txProofs) answer.proof = await this.proveTx(tx, answer.body);
        return answer;
    }

    private async proveTx(tx: string, body: unknown): Promise<TxProofCheck> {
        const network = this.config.network;
        let work = this.proofs.get(tx);
        if (!work) {
            work = (async () => {
                const fn = await (this.opts.loadMithrilTxProof ?? (() => loadMithrilTxProof()))();
                if (!fn) throw new Error("this build has no Mithril verifier");
                return fn({ network, txHashes: [tx], log: (l) => this.log(l) });
            })();
            this.proofs.set(tx, work);
            work.catch(() => {}).finally(() => this.proofs.delete(tx));
        }
        try {
            const proof = await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), PROOF_WAIT_MS))]);
            return proof ? checkTxAnswer(tx, body, proof) : checkTxAnswer(tx, body, null, "the first check walks the certificate chain; ask again in a minute");
        } catch (e) { return checkTxAnswer(tx, body, null, (e as Error).message); }
    }

    submitTx(tx: Uint8Array): string {
        if (!this.node) throw new Error("the node is not connected");
        return this.node.submitTx(tx);
    }

    /** Recent main-chain points for a watcher to intersect at: settled ones (10 min old) so the overlap starts at once. */
    private anchors(): ChainHeader[] {
        const last = this.mainLog.last;
        const settled = last ? this.mainLog.sample(20, 10, last.slot - 600) : [];
        return settled.length ? settled : this.mainLog.sample();
    }

    private startWatchers(): void {
        const net = networkByName(this.config.network);
        if (!net) return;
        const urls = [...new Set(this.config.extraRelays ?? [])].filter((u) => u !== this.config.relayUrl);
        this.watchers = urls.map((url) => new PeerWatcher({ url, networkMagic: net.magic, anchors: () => this.anchors(), WebSocketImpl: this.opts.WebSocketImpl, log: (l) => this.log(l) }));
        for (const w of this.watchers) w.start();
    }

    /** One cross-check, then failover when it calls for one. */
    tick(): void {
        if (!this.running || this.switching || !this.watchers.length) return;
        const node = this.node;
        const t = node?.stats.serverTip;
        // tips are compared only while the main node follows the chain: during a Mithril start its last relay tip is a minutes-old probe
        const following = node && (node.stats.state === "syncing" || node.stats.state === "at-tip");
        const main = { headers: this.mainLog.headers, tip: following && t ? { slot: t.slot, blockNo: t.blockNo } : null };
        this.checks = this.watchers.map((w) => checkPeer(main, w.chain()));
        this.summary = summarize(this.checks);
        this.askNonces(node?.stats.nonceEpoch ?? null);

        // a new main peer on probation: back to the previous one if it served something invalid
        if (this.probation && node && node.stats.endpoint === this.probation.to) {
            const st = node.stats;
            if (st.cryptoBad + st.linkBad + st.bodyBad + st.leaderBad > 0) {
                this.dropped.add(this.probation.to);
                this.switchTo(this.probation.from, null, `${this.probation.to} served an invalid header; dropped for this session`, false);
                this.probation = null;
                return;
            }
            if (st.headers >= PROBATION_HEADERS) this.probation = null;
        }

        // down: the connection failed (backing off) or ended in an error; connecting, the handshake and a Mithril start are progress
        const down = !node || node.stats.state === "error" || node.stats.state === "stopped";
        this.downTicks = down ? this.downTicks + 1 : 0;
        const target = this.summary.switchTo && !this.dropped.has(this.summary.switchTo) ? this.summary.switchTo : null;
        const reason = target ? (this.checks.find((c) => c.url === target)!.verdict === "ahead" ? "the main peer fell behind" : "a longer fork") : "";
        if (!target && this.downTicks >= SWITCH_TICKS) {
            const up = this.checks.find((c) => (c.verdict === "agree" || c.verdict === "pending" || c.verdict === "ahead") && !this.dropped.has(c.url));
            // the down count already waited SWITCH_TICKS checks
            if (up) { this.switchTo(up.url, null, "the main peer is down"); return; }
        }
        if (!target) { this.candidate = null; return; }
        this.candidate = this.candidate?.url === target ? { url: target, ticks: this.candidate.ticks + 1 } : { url: target, ticks: 1 };
        if (this.candidate.ticks < SWITCH_TICKS) return;
        const c = this.checks.find((x) => x.url === target)!;
        this.switchTo(target, c.verdict === "fork" && c.common ? { slot: c.common.slot, hash: c.common.hash } : null, reason);
    }

    /** Ask each extra peer that speaks the light query for the epoch nonce (once per peer and epoch). */
    private askNonces(epoch: number | null): void {
        if (epoch == null) return;
        for (const w of this.watchers) {
            const key = `${w.url}|${epoch}`;
            if (!w.lq || this.peerNonces.has(key)) continue;
            this.peerNonces.set(key, null);
            w.lq.epochNonce(epoch).then((n) => { this.peerNonces.set(key, n ? toHex(n) : null); }).catch(() => { this.peerNonces.delete(key); });
        }
    }

    private switchTo(url: string, rollbackTo: Point | null, reason: string, probation = true): void {
        const from = this.config.relayUrl;
        this.log(`switching the main peer to ${url}: ${reason}`);
        this.failovers.push({ at: Date.now(), from, to: url, reason });
        if (this.failovers.length > 20) this.failovers.shift();
        this.probation = probation ? { from, to: url } : null;
        const extras = (this.config.extraRelays ?? []).filter((u) => u !== url);
        if (!this.dropped.has(from)) extras.unshift(from);
        this.config = { ...this.config, relayUrl: url, extraRelays: extras };
        this.rollbackTo = rollbackTo;
        if (rollbackTo) { this.mainLog.rollbackTo(rollbackTo.slot); this.lastPoint = rollbackTo; }
        this.candidate = null; this.downTicks = 0; this.checks = []; this.summary = null;
        this.switching = true;
        for (const w of this.watchers) void w.stop();
        this.startWatchers();
        this.wake?.();
        this.node?.stop();
    }

    private async run(): Promise<void> {
        const min = this.opts.minBackoffMs ?? 1000, max = this.opts.maxBackoffMs ?? 60_000;
        while (this.running) {
            const net = networkByName(this.config.network);
            if (!net) { this.errors.push(`unknown network ${this.config.network}`); this.running = false; break; }
            const start: StartMode = this.config.startMode;
            if (this.indexNetwork !== net.name) {
                this.index.clear();
                this.observer.clear();
                this.indexNetwork = net.name;
                const sink = this.opts.sinkFor?.(net.name);
                if (sink) {
                    try { const n = await loadIndexFromStore(sink, this.index); if (n) this.log(`indexed ${n} stored block(s) for local queries`); }
                    catch (e) { this.log(`could not index the store: ${(e as Error).message}`); }
                }
            }
            // stopped (or restarted with new settings) while the store was being indexed
            if (!this.running) break;
            const node = new BrowserNode({
                endpoint: this.config.relayUrl, networkMagic: net.magic, start, resumeFrom: this.lastPoint,
                storeSink: this.opts.sinkFor?.(net.name), chunkSlots: net.chunkSlots, index: this.index, observer: this.observer,
                headerLog: this.mainLog, rollbackTo: this.rollbackTo, certifiedStake: (e) => this.certifiedStakeOf(e),
                loadMithril: this.opts.loadMithril, WebSocketImpl: this.opts.WebSocketImpl,
                log: (l) => this.log(l), onStats: () => this.emit(),
            });
            this.node = node;
            this.rollbackTo = null;
            this.switching = false;
            this.connects++;
            this.nextRetryAt = null;
            this.log(`connecting to ${this.config.relayUrl} (${net.name}, magic ${net.magic}), attempt ${this.connects}`);
            const result = await node.start();
            const reachedSync = node.stats.state === "syncing" || node.stats.state === "at-tip" || node.stats.headers > 0 || node.stats.intersect !== "";
            this.lastPoint = this.rollbackTo ?? node.lastPoint() ?? this.lastPoint;
            for (const k of COUNTERS) this.totals[k] += (node.stats as any)[k] ?? 0;
            this.errors.push(...node.stats.errors); this.errors = this.errors.slice(-20);
            this.last = { ...node.stats };
            this.node = null;
            if (!this.running) break;
            if (this.switching) continue; // a failover: connect to the new main peer at once
            if (result.reason === "stopped") break;
            if (reachedSync) this.backoffMs = min;
            const wait = Math.round(this.backoffMs * (0.8 + Math.random() * 0.4));
            this.nextRetryAt = Date.now() + wait;
            this.log(`connection ended (${result.error ?? result.reason}); reconnecting in ${(wait / 1000).toFixed(1)} s`);
            this.emit();
            await new Promise<void>((resolve) => { const t = setTimeout(resolve, wait); this.wake = () => { clearTimeout(t); resolve(); }; });
            this.wake = null;
            this.backoffMs = nextBackoff(this.backoffMs, min, max);
        }
        this.nextRetryAt = null;
    }
}
