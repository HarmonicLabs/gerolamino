/**
 * Keeps a node running: one `BrowserNode` per connection, reconnecting with exponential backoff
 * (1 s doubling to 60 s, with jitter; reset once a connection reaches chain-sync). Each new connection
 * resumes from the stored tip, or from the last verified point when there is no store. Counters are
 * accumulated across connections so the popup shows totals for the session.
 */
import { BrowserNode, emptyStats, type NodeStats, type Point, type StartMode } from "./browserNode";
import type { FileSink } from "./chunkWriter";
import type { MithrilAnchorFn } from "./mithrilLoader";
import { networkByName } from "./networks";
import type { QueuedTx } from "./txSubmit";

export interface RunnerConfig {
    relayUrl: string;
    network: "preview" | "preprod" | "mainnet";
    startMode: "tip" | "mithril" | "chunk";
}

export interface RunnerStats extends NodeStats {
    running: boolean;
    network: string;
    connects: number;
    /** Wall-clock time of the next connection attempt while backing off. */
    nextRetryAt: number | null;
    backoffMs: number;
    pendingTxs: QueuedTx[];
    recent: Array<{ slot: number; blockNo: number; hash: string; size: number; txs: number }>;
}

export interface RunnerOptions {
    config: RunnerConfig;
    /** A store for the network (OPFS in the extension); undefined runs without persistence. */
    sinkFor?: (network: string) => FileSink | undefined;
    loadMithril?: () => Promise<MithrilAnchorFn | null>;
    WebSocketImpl?: typeof WebSocket;
    log?: (line: string) => void;
    onStats?: (s: RunnerStats) => void;
    /** Backoff bounds (tests shorten them). */
    minBackoffMs?: number;
    maxBackoffMs?: number;
}

/** Counters summed over connections. */
const COUNTERS = ["headers", "linkOk", "linkBad", "blocksFetched", "bodyOk", "bodyBad", "rollbacks", "rolledBackBlocks", "cryptoOk", "cryptoBad", "cryptoSkipped", "cryptoMs", "leaderOk", "leaderBad", "leaderSkipped", "bytes"] as const;
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
        return {
            ...s, running: this.running, network: this.config.network, connects: this.connects,
            nextRetryAt: this.nextRetryAt, backoffMs: this.backoffMs, pendingTxs: this.node?.pendingTxs() ?? [],
            recent: this.node ? this.node.recent.slice(-12).reverse() : [],
        };
    }

    private emit(): void { this.opts.onStats?.(this.stats()); }
    private log(l: string): void { this.opts.log?.(l); }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.loop = this.run();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.node?.stop();
        this.wake?.();
        await this.loop;
        this.loop = null;
        this.emit();
    }

    /** Apply new settings: stop the current connection and start again (store per network). */
    async restart(config: RunnerConfig): Promise<void> {
        // a new network or start mode means a new start point; a new relay URL keeps following the same chain
        const newStart = config.network !== this.config.network || config.startMode !== this.config.startMode;
        await this.stop();
        this.config = { ...config };
        if (newStart) this.lastPoint = null;
        this.backoffMs = this.opts.minBackoffMs ?? 1000;
        this.start();
    }

    submitTx(tx: Uint8Array): string {
        if (!this.node) throw new Error("the node is not connected");
        return this.node.submitTx(tx);
    }

    private async run(): Promise<void> {
        const min = this.opts.minBackoffMs ?? 1000, max = this.opts.maxBackoffMs ?? 60_000;
        while (this.running) {
            const net = networkByName(this.config.network);
            if (!net) { this.errors.push(`unknown network ${this.config.network}`); this.running = false; break; }
            const start: StartMode = this.config.startMode;
            const node = new BrowserNode({
                endpoint: this.config.relayUrl, networkMagic: net.magic, start, resumeFrom: this.lastPoint,
                storeSink: this.opts.sinkFor?.(net.name), chunkSlots: net.chunkSlots,
                loadMithril: this.opts.loadMithril, WebSocketImpl: this.opts.WebSocketImpl,
                log: (l) => this.log(l), onStats: () => this.emit(),
            });
            this.node = node;
            this.connects++;
            this.nextRetryAt = null;
            this.log(`connecting to ${this.config.relayUrl} (${net.name}, magic ${net.magic}), attempt ${this.connects}`);
            const result = await node.start();
            const reachedSync = node.stats.state === "syncing" || node.stats.state === "at-tip" || node.stats.headers > 0 || node.stats.intersect !== "";
            this.lastPoint = node.lastPoint() ?? this.lastPoint;
            for (const k of COUNTERS) this.totals[k] += (node.stats as any)[k] ?? 0;
            this.errors.push(...node.stats.errors); this.errors = this.errors.slice(-20);
            this.last = { ...node.stats };
            this.node = null;
            if (!this.running || result.reason === "stopped") break;
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
