/**
 * A second opinion: a headers-only connection to an extra peer. It intersects at recent points of the main chain
 * (newest first), follows that peer's headers with chain-sync and keeps them in a HeaderLog for crossCheck.ts. No
 * bodies, no store: a few hundred bytes per block. Each header's hash is recomputed and its prev-hash link checked,
 * so a watcher cannot be shown a chain that does not hang together. When the peer speaks the light query, its epoch
 * nonce is kept too, for comparing nonces across peers. Reconnects with backoff (5 s doubling to 60 s) until stopped.
 */
import { ChainPoint, ChainSyncClient, ChainSyncIntersectNotFound, ChainSyncRollBackwards, ChainSyncRollForward, KeepAliveClient, Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { summarizeHeader } from "./browserNode";
import { HeaderLog, type ChainHeader, type PeerChain, type Tip } from "./crossCheck";
import { proposeBrowserHandshake } from "./handshake";
import { LightQueryClient, N2N_WS_SUBPROTOCOL } from "./lightQuery";
import { openN2NSocket } from "./wsConnect";

export interface PeerWatcherOptions {
    url: string;
    networkMagic: number;
    /** Recent points of the main chain, newest first (HeaderLog.sample()). */
    anchors: () => ChainHeader[];
    WebSocketImpl?: typeof WebSocket;
    connectTimeoutMs?: number;
    log?: (line: string) => void;
    /** Called after every header or rollback. */
    onChange?: () => void;
}

const pointOf = (h: { slot: number; hash: string }) => new ChainPoint({ blockHeader: { slotNumber: BigInt(h.slot), hash: fromHex(h.hash) } });
const tipOf = (m: any): Tip | null => (m?.tip ? { slot: Number(m.tip.point.blockHeader?.slotNumber ?? 0), blockNo: Number(m.tip.blockNo) } : null);

export class PeerWatcher {
    readonly log = new HeaderLog();
    connected = false;
    sharedHistory: boolean | null = null;
    tip: Tip | null = null;
    linkBad = 0;
    error: string | null = null;
    /** The peer's light query (null when it has none or is not connected). */
    lq: LightQueryClient | null = null;
    private stopped = false;
    private socket: WebSocket | null = null;
    private mux: Multiplexer | null = null;
    private loop: Promise<void> | null = null;
    private wake: (() => void) | null = null;

    constructor(readonly opts: PeerWatcherOptions) {}

    get url(): string { return this.opts.url; }

    chain(): PeerChain {
        return { url: this.opts.url, connected: this.connected, sharedHistory: this.sharedHistory, headers: this.log.headers, tip: this.tip };
    }

    start(): void { if (!this.loop) this.loop = this.run(); }

    async stop(): Promise<void> {
        this.stopped = true;
        this.teardown();
        this.wake?.();
        await this.loop;
    }

    private async run(): Promise<void> {
        let backoff = 5000;
        while (!this.stopped) {
            try { await this.once(); backoff = 5000; }
            catch (e) { if (!this.stopped) { this.error = (e as Error).message; this.opts.log?.(`peer ${this.opts.url}: ${this.error}`); } }
            this.teardown();
            this.connected = false;
            this.opts.onChange?.();
            if (this.stopped) break;
            await new Promise<void>((r) => { const t = setTimeout(r, backoff); this.wake = () => { clearTimeout(t); r(); }; });
            backoff = Math.min(60_000, backoff * 2);
        }
    }

    private async once(): Promise<void> {
        const socket = await openN2NSocket(this.opts.url, { WebSocketImpl: this.opts.WebSocketImpl, timeoutMs: this.opts.connectTimeoutMs, stopped: () => this.stopped });
        this.socket = socket;
        let closeWith: (e: Error) => void = () => {};
        const closed = new Promise<never>((_, rej) => { closeWith = rej; });
        closed.catch(() => {});
        socket.addEventListener("close", () => closeWith(new Error("connection closed")));
        socket.addEventListener("error", () => closeWith(new Error("WebSocket error")));
        const guard = <T>(p: Promise<T>) => Promise.race([p, closed]);
        if (this.stopped) return;
        let handedOut = false;
        const mux = new Multiplexer({ protocolType: "node-to-node", connect: () => { if (handedOut) throw new Error("no reconnect"); handedOut = true; return socket as any; } });
        this.mux = mux;
        mux.on("error", () => {});
        await guard(proposeBrowserHandshake(mux, this.opts.networkMagic));
        if (socket.protocol !== N2N_WS_SUBPROTOCOL) {
            const lq = new LightQueryClient(mux);
            this.lq = (await guard(lq.supported)) ? lq : (lq.dispose(), null);
        }
        const ka = new KeepAliveClient(mux);
        const kaTimer = setInterval(() => { ka.request((Date.now() / 1000) & 0xffff).catch(() => {}); }, 20_000);
        try {
            const cs = new ChainSyncClient(mux);
            const anchors = this.opts.anchors();
            let isect: any = anchors.length ? await guard(cs.findIntersect(anchors.map(pointOf))) : null;
            this.tip = tipOf(isect) ?? this.tip;
            if (isect && !(isect instanceof ChainSyncIntersectNotFound)) this.sharedHistory = true;
            else {
                this.sharedHistory = anchors.length ? false : null;
                const probe = await guard(cs.findIntersect([ChainPoint.origin]));
                const t: any = (probe as any).tip?.point;
                isect = await guard(cs.findIntersect([t?.blockHeader ? t : ChainPoint.origin]));
                if (isect instanceof ChainSyncIntersectNotFound) throw new Error("intersect not found at the peer's own tip");
            }
            this.tip = tipOf(isect) ?? this.tip;
            const ip = isect.point?.blockHeader;
            this.log.clear();
            let expectPrev: string | null = ip ? toHex(ip.hash) : null;
            this.connected = true; this.error = null;
            this.opts.log?.(`peer ${this.opts.url}: watching from slot ${ip ? Number(ip.slotNumber) : 0}${this.sharedHistory === false ? " (shares no recent block with the main chain)" : ""}`);
            this.opts.onChange?.();
            while (!this.stopped) {
                const msg: any = await guard(cs.requestNext());
                this.tip = tipOf(msg) ?? this.tip;
                if (msg instanceof ChainSyncRollBackwards) {
                    const p = (msg as any).point?.blockHeader;
                    this.log.rollbackTo(p ? Number(p.slotNumber) : -1);
                    expectPrev = p ? toHex(p.hash) : null;
                } else if (msg instanceof ChainSyncRollForward) {
                    const h = summarizeHeader(msg.data);
                    if (expectPrev != null && h.prevHash !== expectPrev) { this.linkBad++; this.log.clear(); }
                    this.log.add({ slot: h.slot, blockNo: h.blockNo, hash: h.hash });
                    expectPrev = h.hash;
                }
                this.opts.onChange?.();
            }
        } finally { clearInterval(kaTimer); }
    }

    private teardown(): void {
        this.lq?.dispose(); this.lq = null;
        try { this.mux?.close({ closeSocket: true }); } catch { /* ignore */ }
        try { this.socket?.close(); } catch { /* ignore */ }
        this.mux = null; this.socket = null;
    }
}
