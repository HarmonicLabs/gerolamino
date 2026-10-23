/**
 * Gerolamino node core: a verifying Cardano node over N2N-over-WebSocket (ported from Gerolamo's browser node).
 *
 * One connection's life: open the relay's WebSocket bearer, run the node-to-node handshake (initiator
 * only: a browser cannot serve), start keep-alive, the light query and tx-submission, pick a start point
 * (the stored OPFS tip when resuming, else the relay's tip, a Mithril-certified point or the relay's
 * newest immutable chunk), intersect, and follow the chain with chain-sync. For every header:
 *
 *   1. header hash recomputed (blake2b-256 of the header bytes), prev-hash link to the previous header;
 *   2. header cryptography: opcert, KES and VRF against the epoch nonce from the light query;
 *   3. leader eligibility against the pool's stake from the light query;
 *   4. block fetched with block-fetch, body hash checked against the header (`hashTxSeq`) and its size;
 *   5. the verified block appended to the chunk store (cardano-node immutable format, OPFS in the browser).
 *
 * RollBackward truncates the store to the rollback point. No DOM and no Bun APIs: the same module runs in
 * the extension's offscreen document and under Bun (`scripts/node-smoke.ts`). `start()` resolves when the
 * connection ends (closed, error or `stop()`); reconnecting with backoff is `NodeRunner`'s job (runner.ts).
 */
import { CborArray, CborTag, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import { blake2b_224, blake2b_256 } from "@harmoniclabs/crypto";
import {
    BlockFetchClient,
    ChainPoint,
    ChainSyncClient,
    ChainSyncIntersectNotFound,
    ChainSyncRollBackwards,
    ChainSyncRollForward,
    KeepAliveClient,
    Multiplexer,
} from "@harmoniclabs/ouroboros-miniprotocols-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { arrayElements, bytesAt, uintAt } from "./cbor";
import { decodePrimary, decodeSecondaryEntry, filledRelativeSlots, SECONDARY_ENTRY_SIZE } from "./chunkFormat";
import { ChunkWriter, type FileSink } from "./chunkWriter";
import { proposeBrowserHandshake } from "./handshake";
import { parseHeaderCrypto, verifyHeaderCrypto } from "./headerVerify";
import { isSlotLeader } from "./leaderMath";
import { LightQueryClient, type PoolStakeInfo } from "./lightQuery";
import { loadMithrilAnchor, type MithrilAnchor, type MithrilAnchorFn } from "./mithrilLoader";
import { epochOfSlot, networkByMagic } from "./networks";
import { TxSubmitClient, type QueuedTx } from "./txSubmit";

export interface HeaderSummary {
    eraTag: number;          // wire era tag: 2 Shelley … 7 Conway
    slot: number;
    blockNo: number;
    hash: string;            // hex
    prevHash: string | null; // hex
    bodySize: number;
    bodyHash: string;        // hex, from the header
    headerBytes: Uint8Array;
}

export type NodeState = "idle" | "connecting" | "handshake" | "anchoring" | "syncing" | "at-tip" | "stopped" | "error";
export type StartMode = "tip" | "mithril" | "chunk" | { slot: number; hash: string };
export interface Point { slot: number; hash: string }

export interface NodeStats {
    endpoint: string;
    state: NodeState;
    version: number | null;
    /** The relay's handshake reply: true when it, too, runs initiator-only (it should not). */
    remoteInitiatorOnly: boolean | null;
    serverTip: { slot: number; blockNo: number; hash: string } | null;
    intersect: string;
    startMode: string;
    headers: number;
    linkOk: number;
    linkBad: number;
    blocksFetched: number;
    bodyOk: number;
    bodyBad: number;
    rollbacks: number;
    rolledBackBlocks: number;
    /** Header cryptography (opcert + KES + VRF against the epoch nonce from the light query). */
    cryptoOk: number;
    cryptoBad: number;
    cryptoSkipped: number;
    cryptoMs: number;
    nonceEpoch: number | null;
    /** Leader eligibility (VRF leader value below the pool's stake threshold). */
    leaderOk: number;
    leaderBad: number;
    leaderSkipped: number;
    lightQuery: boolean | null;
    /** Persistent store (chunk files). */
    storedBlocks: number;
    storedBytes: number;
    storedChunks: number;
    storedTipSlot: number | null;
    resumedFrom: number | null;
    /** Mithril-certified anchor when started that way. */
    anchor: MithrilAnchor | null;
    lastSlot: number | null;
    lastBlockNo: number | null;
    lastHash: string | null;
    bytes: number;
    keepAliveRttMs: number | null;
    startedAt: number | null;
    firstHeaderAt: number | null;
    lastHeaderAt: number | null;
    error: string | null;
    errors: string[];
}

export interface BrowserNodeOptions {
    endpoint: string;                 // ws://host:port/path or wss://…
    networkMagic: number;
    /** Start point when the store is empty: the relay's tip (default), a Mithril-certified point, the relay's newest complete chunk, or an explicit point. */
    start?: StartMode;
    /** A point to resume from when there is no store (the runner passes the last verified point across reconnects). */
    resumeFrom?: Point | null;
    /** Fetch and verify bodies for every header (default true). */
    fetchBodies?: boolean;
    /** Keep at most this many recent block summaries in memory (default 64). */
    keep?: number;
    /** Persist verified blocks as cardano-node chunk files through this sink (OPFS in the extension). */
    storeSink?: FileSink;
    /** Slots per chunk (10·k: 4320 preview/preprod, 21600 mainnet); default from the network. */
    chunkSlots?: number;
    /** Supplies the Mithril verifier for the "mithril" start (default: dynamic import, see mithrilLoader.ts). */
    loadMithril?: () => Promise<MithrilAnchorFn | null>;
    connectTimeoutMs?: number;
    keepAliveMs?: number;
    /** WebSocket constructor (default: the global one). */
    WebSocketImpl?: typeof WebSocket;
    log?: (line: string) => void;
    onStats?: (s: NodeStats) => void;
}

const hex = (b: Uint8Array) => toHex(b);
const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
const pointOf = (p: Point) => new ChainPoint({ blockHeader: { slotNumber: BigInt(p.slot), hash: fromHex(p.hash) } });
const L_PREFIX = new TextEncoder().encode("L");

/** Parse the chain-sync RollForward payload `[eraIdx, #6.24(header)]` into a summary (Shelley-era and later). */
export function summarizeHeader(data: CborObj): HeaderSummary {
    if (!(data instanceof CborArray) || data.array.length < 2) throw new Error("RollForward data is not [era, header]");
    const eraIdx = Number((data.array[0] as CborUInt).num);
    const eraTag = eraIdx + 1; // header era index (Shelley = 1) → wire era tag (Shelley = 2)
    if (eraTag < 2) throw new Error("Byron headers are not handled by the light client");
    const tagged = data.array[1];
    const headerBytes: Uint8Array = tagged instanceof CborTag ? (tagged.data as any).bytes : (tagged as any).bytes;
    return summarizeHeaderBytes(headerBytes, eraTag);
}

export function summarizeHeaderBytes(headerBytes: Uint8Array, eraTag: number): HeaderSummary {
    // header = [header_body, kes_signature]; body layout differs before Babbage
    const [bodyRange] = arrayElements(headerBytes, 0);
    const fields = arrayElements(headerBytes, bodyRange!.start);
    const babbage = eraTag >= 6;
    const slot = Number(uintAt(headerBytes, fields[1]!.start));
    const blockNo = Number(uintAt(headerBytes, fields[0]!.start));
    const prev = headerBytes[fields[2]!.start] === 0xf6 ? null : hex(bytesAt(headerBytes, fields[2]!.start));
    const sizeIdx = babbage ? 6 : 7, hashIdx = babbage ? 7 : 8;
    const bodySize = Number(uintAt(headerBytes, fields[sizeIdx]!.start));
    const bodyHash = hex(bytesAt(headerBytes, fields[hashIdx]!.start));
    return { eraTag, slot, blockNo, hash: hex(blake2b_256(headerBytes)), prevHash: prev, bodySize, bodyHash, headerBytes };
}

/** cardano-ledger `hashTxSeq` over the block's body segments (`[era, [hdr, bodies, wits, aux, invalid?]]`), and the body size. */
export function bodyHashOf(block: Uint8Array): { hash: string; eraTag: number; txs: number; size: number } {
    const outer = arrayElements(block, 0);
    const eraTag = Number(uintAt(block, outer[0]!.start));
    const parts = arrayElements(block, outer[1]!.start);
    const seg = (i: number) => block.subarray(parts[i]!.start, parts[i]!.end);
    const segs = [seg(1), seg(2), seg(3)];
    if (eraTag >= 5 && parts.length > 4) segs.push(seg(4)); // Alonzo+: invalid transactions
    const cat = new Uint8Array(segs.length * 32);
    segs.forEach((s, i) => cat.set(blake2b_256(s), i * 32));
    const bodies = arrayElements(block, parts[1]!.start);
    return { hash: hex(blake2b_256(cat)), eraTag, txs: bodies.length, size: segs.reduce((a, s) => a + s.length, 0) };
}

/** The last block of a complete chunk (from its primary and secondary index). */
export function lastPointOfChunk(primary: Uint8Array, secondary: Uint8Array): Point | null {
    const entries = Math.floor(secondary.length / SECONDARY_ENTRY_SIZE);
    if (!entries) return null;
    const filled = filledRelativeSlots(decodePrimary(primary));
    if (filled.length !== entries) throw new Error("chunk index inconsistent");
    const e = decodeSecondaryEntry(secondary, entries - 1, filled[entries - 1] === 0);
    return { slot: e.slotOrEbb, hash: hex(e.headerHash) };
}

class ConnectionClosed extends Error {}

export function emptyStats(endpoint: string): NodeStats {
    return {
        endpoint, state: "idle", version: null, remoteInitiatorOnly: null, serverTip: null, intersect: "", startMode: "",
        headers: 0, linkOk: 0, linkBad: 0, blocksFetched: 0, bodyOk: 0, bodyBad: 0, rollbacks: 0, rolledBackBlocks: 0,
        cryptoOk: 0, cryptoBad: 0, cryptoSkipped: 0, cryptoMs: 0, nonceEpoch: null, leaderOk: 0, leaderBad: 0, leaderSkipped: 0, lightQuery: null,
        storedBlocks: 0, storedBytes: 0, storedChunks: 0, storedTipSlot: null, resumedFrom: null, anchor: null,
        lastSlot: null, lastBlockNo: null, lastHash: null, bytes: 0, keepAliveRttMs: null, startedAt: null, firstHeaderAt: null, lastHeaderAt: null,
        error: null, errors: [],
    };
}

export class BrowserNode {
    readonly stats: NodeStats;
    private readonly opts: BrowserNodeOptions;
    private mux: Multiplexer | null = null;
    private socket: WebSocket | null = null;
    private stopped = false;
    private lq: LightQueryClient | null = null;
    private txc: TxSubmitClient | null = null;
    private writer: ChunkWriter | null = null;
    private nonces = new Map<number, Uint8Array | null>();
    private stakeCache = new Map<string, PoolStakeInfo>();
    private closed: Promise<never>;
    private closeWith: (e: Error) => void = () => {};
    /** Recent blocks, newest last. */
    readonly recent: Array<{ slot: number; blockNo: number; hash: string; size: number; txs: number }> = [];

    constructor(opts: BrowserNodeOptions) {
        this.opts = opts;
        this.stats = emptyStats(opts.endpoint);
        this.closed = new Promise<never>((_, reject) => { this.closeWith = reject; });
        this.closed.catch(() => {});
    }

    /** Offer a signed transaction (CBOR bytes) to the relay; returns its id. Needs a live connection. */
    submitTx(tx: Uint8Array): string {
        if (!this.txc) throw new Error("not connected");
        return this.txc.submit(tx);
    }
    /** Transactions offered this connection that the relay has not acknowledged yet. */
    pendingTxs(): QueuedTx[] { return this.txc?.list() ?? []; }

    /** The last verified point (header hash checked and linked). */
    lastPoint(): Point | null { return this.stats.lastSlot != null && this.stats.lastHash ? { slot: this.stats.lastSlot, hash: this.stats.lastHash } : null; }

    private log(line: string): void { this.opts.log?.(line); }
    private emit(): void { this.opts.onStats?.({ ...this.stats, errors: [...this.stats.errors] }); }
    private noteError(msg: string): void { this.stats.errors.push(`${new Date().toISOString().slice(11, 19)} ${msg}`); if (this.stats.errors.length > 20) this.stats.errors.shift(); this.log(msg); }

    /** Race an operation against the connection closing. */
    private guard<T>(p: Promise<T>): Promise<T> { return Promise.race([p, this.closed]); }

    private async epochNonce(epoch: number): Promise<Uint8Array | null> {
        if (this.nonces.has(epoch)) return this.nonces.get(epoch)!;
        let nonce: Uint8Array | null = null;
        if (this.lq && this.stats.lightQuery) {
            try {
                nonce = await this.guard(this.lq.epochNonce(epoch));
                if (nonce) { this.stats.nonceEpoch = epoch; this.log(`epoch ${epoch} nonce ${hex(nonce).slice(0, 16)}… over the WebSocket (light query)`); }
                else this.log(`epoch ${epoch}: relay has no nonce yet`);
            } catch (e) { if (e instanceof ConnectionClosed) throw e; this.log(`light query nonce failed: ${(e as Error).message}`); return null; }
        }
        this.nonces.set(epoch, nonce);
        return nonce;
    }

    private async poolStake(epoch: number, poolId: Uint8Array): Promise<PoolStakeInfo | null> {
        if (!this.lq || !this.stats.lightQuery) return null;
        const key = `${epoch}:${hex(poolId)}`;
        let st = this.stakeCache.get(key);
        if (!st) {
            st = await this.guard(this.lq.poolStake(epoch, poolId));
            if (this.stakeCache.size > 2000) this.stakeCache.clear();
            this.stakeCache.set(key, st);
        }
        return st;
    }

    private openSocket(): Promise<WebSocket> {
        const { endpoint } = this.opts;
        const WS = this.opts.WebSocketImpl ?? WebSocket;
        return new Promise<WebSocket>((resolve, reject) => {
            const ws = new WS(endpoint);
            ws.binaryType = "arraybuffer";
            const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error(`connect to ${endpoint} timed out`)); }, this.opts.connectTimeoutMs ?? 15_000);
            ws.addEventListener("open", () => { clearTimeout(timer); resolve(ws); }, { once: true });
            ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`cannot connect to ${endpoint}`)); }, { once: true });
        });
    }

    /** Run one connection until it ends. Resolves with the reason (never rejects). */
    async start(): Promise<{ reason: "stopped" | "closed" | "error"; error?: string }> {
        const net = networkByMagic(this.opts.networkMagic);
        let ka: ReturnType<typeof setInterval> | undefined;
        this.stats.state = "connecting"; this.stats.startedAt = Date.now(); this.emit();
        try {
            const socket = await this.openSocket();
            this.socket = socket;
            if (this.stopped) { socket.close(); return { reason: "stopped" }; }
            socket.addEventListener("message", (ev) => { this.stats.bytes += (ev.data as ArrayBuffer).byteLength ?? 0; });
            socket.addEventListener("close", (ev) => this.closeWith(new ConnectionClosed(this.stopped ? "stopped" : `connection closed by the relay (code ${(ev as CloseEvent).code ?? "?"})`)));
            socket.addEventListener("error", () => this.closeWith(new ConnectionClosed("WebSocket error")));
            let handedOut = false;
            this.mux = new Multiplexer({ protocolType: "node-to-node", connect: () => { if (handedOut) throw new Error("reconnect is the runner's job"); handedOut = true; return socket as any; } });
            this.mux.on("error", (e: Error) => this.noteError(`multiplexer: ${e.message}`));

            // handshake: initiator only, versions 14/15
            this.stats.state = "handshake"; this.emit();
            const hs = await this.guard(proposeBrowserHandshake(this.mux, this.opts.networkMagic));
            this.stats.version = hs.version; this.stats.remoteInitiatorOnly = hs.remote.initiatorOnlyDiffusionMode;
            this.log(`handshake accepted, N2N version ${hs.version} (we are initiator-only)`);

            this.lq = new LightQueryClient(this.mux);
            this.txc = new TxSubmitClient(this.mux, (l) => this.log(l), () => this.emit());
            const keepAlive = new KeepAliveClient(this.mux);
            ka = setInterval(() => {
                const t0 = Date.now();
                keepAlive.request((t0 / 1000) & 0xffff).then(() => { this.stats.keepAliveRttMs = Date.now() - t0; }).catch(() => {});
            }, this.opts.keepAliveMs ?? 20_000);
            this.stats.lightQuery = await this.guard(this.lq.supported);
            this.log(this.stats.lightQuery ? "relay speaks the light-query protocol (nonce, stake, chunks over the WebSocket)" : "relay has no light-query protocol: header crypto and leader checks will be skipped");

            const cs = new ChainSyncClient(this.mux);
            const bf = new BlockFetchClient(this.mux);
            const tipOf = (m: any) => m?.tip ? { slot: Number(m.tip.point.blockHeader?.slotNumber ?? 0), blockNo: Number(m.tip.blockNo), hash: m.tip.point.blockHeader ? hex(m.tip.point.blockHeader.hash) : "" } : null;

            // 1. the relay's tip
            const probe = await this.guard(cs.findIntersect([ChainPoint.origin]));
            this.stats.serverTip = tipOf(probe);

            // 2. the start point: stored tip > explicit point > runner's last point > mode
            const mode = this.opts.start ?? "tip";
            let from: Point | null = null;
            let resuming = false;
            if (this.opts.storeSink) {
                this.writer = new ChunkWriter(this.opts.storeSink, this.opts.chunkSlots ?? net?.chunkSlots ?? 4320);
                const stored = await this.writer.resume();
                this.syncStoreStats();
                if (stored) { from = { slot: stored.slot, hash: hex(stored.hash) }; resuming = true; this.stats.resumedFrom = stored.slot; this.log(`store holds ${this.stats.storedBlocks} blocks; resuming from the stored tip at slot ${stored.slot}`); }
            }
            if (!from && typeof mode === "object") from = mode;
            if (!from && this.opts.resumeFrom) { from = this.opts.resumeFrom; resuming = true; this.log(`resuming from the last verified point, slot ${from.slot}`); }
            if (!from && mode === "mithril") from = await this.mithrilStart(net?.name);
            if (!from && mode === "chunk") from = await this.chunkStart(net?.chunkSlots ?? 4320);
            this.stats.startMode = resuming ? "resume" : typeof mode === "object" ? "point" : mode;

            let isect = from ? await this.guard(cs.findIntersect([pointOf(from)])) : null;
            if (from && isect instanceof ChainSyncIntersectNotFound) {
                this.noteError(`start point slot ${from.slot} is not on the relay's chain; starting at the relay's tip`);
                from = null; isect = null;
            }
            if (!isect) {
                const t = this.stats.serverTip;
                isect = await this.guard(cs.findIntersect([t?.hash ? pointOf({ slot: t.slot, hash: t.hash }) : ChainPoint.origin]));
                if (isect instanceof ChainSyncIntersectNotFound) throw new Error("intersect not found at the relay's own tip");
                from = t?.hash ? { slot: t.slot, hash: t.hash } : null;
            }
            const found: any = isect;
            this.stats.intersect = found.point?.blockHeader ? `slot ${found.point.blockHeader.slotNumber}` : "origin";
            this.stats.serverTip = tipOf(found) ?? this.stats.serverTip;
            this.log(`intersect at ${this.stats.intersect}; relay tip slot ${this.stats.serverTip?.slot} height ${this.stats.serverTip?.blockNo}`);
            if (from) { this.stats.lastSlot = from.slot; this.stats.lastHash = from.hash; }
            this.stats.state = "syncing"; this.emit();

            // 3. follow
            let expectPrev: string | null = from?.hash ?? null;
            while (!this.stopped) {
                const msg: any = await this.guard(cs.requestNext());
                if (msg instanceof ChainSyncRollBackwards) {
                    this.stats.serverTip = tipOf(msg) ?? this.stats.serverTip;
                    const p = (msg as any).point?.blockHeader;
                    const slot = p ? Number(p.slotNumber) : -1;
                    expectPrev = p ? hex(p.hash) : null;
                    if (this.stats.lastSlot != null && slot < this.stats.lastSlot) {
                        this.stats.rollbacks++;
                        let dropped = 0;
                        while (this.recent.length && this.recent[this.recent.length - 1]!.slot > slot) { this.recent.pop(); dropped++; }
                        if (this.writer) { try { dropped = Math.max(dropped, await this.writer.rollbackTo(slot)); this.syncStoreStats(); } catch (e) { this.noteError(`store rollback: ${(e as Error).message}`); } }
                        this.stats.rolledBackBlocks += dropped;
                        this.log(`RollBackward to slot ${slot} (${dropped} block(s) undone)`);
                    }
                    if (p) { this.stats.lastSlot = slot; this.stats.lastHash = expectPrev; }
                    this.emit();
                    continue;
                }
                if (!(msg instanceof ChainSyncRollForward)) { this.log(`unexpected chain-sync message ${msg?.constructor?.name}`); continue; }
                this.stats.serverTip = tipOf(msg) ?? this.stats.serverTip;
                let h: HeaderSummary;
                try { h = summarizeHeader(msg.data); } catch (e) { this.noteError(`header skipped: ${(e as Error).message}`); continue; }
                await this.processHeader(h, expectPrev, bf, net);
                expectPrev = h.hash;
                this.stats.state = this.stats.serverTip && h.slot >= this.stats.serverTip.slot ? "at-tip" : "syncing";
                this.emit();
            }
            return { reason: "stopped" };
        } catch (err) {
            const message = (err as Error).message ?? String(err);
            if (this.stopped) { this.stats.state = "stopped"; this.emit(); return { reason: "stopped" }; }
            const closed = err instanceof ConnectionClosed;
            this.stats.state = "error"; this.stats.error = message; this.noteError(`${closed ? "connection" : "error"}: ${message}`); this.emit();
            return { reason: closed ? "closed" : "error", error: message };
        } finally {
            if (ka) clearInterval(ka);
            this.teardown();
        }
    }

    private async processHeader(h: HeaderSummary, expectPrev: string | null, bf: BlockFetchClient, net: ReturnType<typeof networkByMagic>): Promise<void> {
        const now = Date.now();
        this.stats.headers++;
        this.stats.firstHeaderAt ??= now; this.stats.lastHeaderAt = now;
        let linked = true;
        if (expectPrev != null) {
            if (h.prevHash === expectPrev) this.stats.linkOk++;
            else { linked = false; this.stats.linkBad++; this.noteError(`LINK MISMATCH at slot ${h.slot}: prev ${h.prevHash?.slice(0, 16)} ≠ ${expectPrev.slice(0, 16)}`); }
        }
        // ask for the body first: the network works while the header crypto runs
        const pt = pointOf({ slot: h.slot, hash: h.hash });
        const fetching = this.opts.fetchBodies !== false ? this.guard(bf.requestRange(pt, pt)) : null;
        fetching?.catch(() => {});

        // header cryptography and leader eligibility
        const nonce = net ? await this.epochNonce(epochOfSlot(net, h.slot)) : null;
        let cryptoOk = false;
        if (net && nonce) {
            try {
                const hc = parseHeaderCrypto(h.headerBytes, h.eraTag);
                const r = verifyHeaderCrypto(hc, nonce, net.slotsPerKESPeriod, net.maxKESEvolutions);
                this.stats.cryptoMs += r.ms.opcert + r.ms.kes + r.ms.vrf;
                cryptoOk = r.opcertOk && r.kesOk && r.vrfOk;
                if (cryptoOk) this.stats.cryptoOk++; else { this.stats.cryptoBad++; this.noteError(`HEADER CRYPTO FAILED at slot ${h.slot}: ${r.detail.join("; ")}`); }
                const epoch = epochOfSlot(net, h.slot);
                const st = cryptoOk ? await this.poolStake(epoch, blake2b_224(hc.issuerVkey)) : null;
                if (st && st.poolStake != null && st.totalActiveStake) {
                    const leaderValue = hc.vrf ? blake2b_256(concatBytes(L_PREFIX, hc.vrf.output)) : hc.leaderVrf!.output;
                    if (isSlotLeader(leaderValue, { num: st.poolStake, den: st.totalActiveStake }, Number(st.activeSlotsCoeff.num) / Number(st.activeSlotsCoeff.den))) this.stats.leaderOk++;
                    else { this.stats.leaderBad++; this.noteError(`LEADER CHECK FAILED at slot ${h.slot}: pool ${hex(blake2b_224(hc.issuerVkey)).slice(0, 12)}… stake ${st.poolStake}/${st.totalActiveStake}`); }
                } else this.stats.leaderSkipped++;
            } catch (e) {
                if (e instanceof ConnectionClosed) throw e;
                this.stats.cryptoBad++; this.noteError(`header crypto threw at slot ${h.slot}: ${(e as Error).message}`);
            }
        } else { this.stats.cryptoSkipped++; this.stats.leaderSkipped++; }
        this.stats.lastSlot = h.slot; this.stats.lastBlockNo = h.blockNo; this.stats.lastHash = h.hash;

        if (!fetching) return;
        const blocks = await fetching;
        const b = Array.isArray(blocks) ? blocks[0] : null;
        if (!b) { this.noteError(`relay returned no block for slot ${h.slot}`); return; }
        this.stats.blocksFetched++;
        const bytes: Uint8Array = b.blockData;
        let got: ReturnType<typeof bodyHashOf>;
        try { got = bodyHashOf(bytes); } catch (e) { this.stats.bodyBad++; this.noteError(`block at slot ${h.slot} does not parse: ${(e as Error).message}`); return; }
        const bodyOk = got.hash === h.bodyHash && got.size === h.bodySize;
        if (bodyOk) this.stats.bodyOk++;
        else { this.stats.bodyBad++; this.noteError(`BODY MISMATCH at slot ${h.slot}: ${got.hash !== h.bodyHash ? "hash" : `size ${got.size} ≠ ${h.bodySize}`}`); }
        this.recent.push({ slot: h.slot, blockNo: h.blockNo, hash: h.hash, size: bytes.length, txs: got.txs });
        while (this.recent.length > (this.opts.keep ?? 64)) this.recent.shift();
        // only fully verified blocks are stored
        if (this.writer && bodyOk && linked && (cryptoOk || !nonce)) {
            try { await this.writer.append(h.slot, fromHex(h.hash), bytes); this.syncStoreStats(); }
            catch (e) { this.noteError(`store: ${(e as Error).message}`); }
        }
    }

    private syncStoreStats(): void {
        if (!this.writer) return;
        const st = this.writer.stats;
        this.stats.storedBlocks = st.blocks; this.stats.storedBytes = st.bytes; this.stats.storedChunks = st.chunks;
        this.stats.storedTipSlot = this.writer.tip?.slot ?? null;
    }

    private async mithrilStart(network: string | undefined): Promise<Point> {
        if (!network) throw new Error("unknown network magic for the Mithril start");
        if (!this.lq || !this.stats.lightQuery) throw new Error("the Mithril start needs the relay's light-query protocol (GetChunk)");
        this.stats.state = "anchoring"; this.emit();
        const anchorFn = await (this.opts.loadMithril ?? (() => loadMithrilAnchor(undefined, (l) => this.log(l))))();
        if (!anchorFn) throw new Error("Mithril start selected but the Mithril verifier is not available in this build");
        const a = await this.guard(anchorFn({ network, lq: this.lq, log: (l) => this.log(l) }));
        this.stats.anchor = a;
        this.log(`Mithril-certified start point: slot ${a.slot} ${String(a.hash).slice(0, 16)}…`);
        return { slot: Number(a.slot), hash: String(a.hash) };
    }

    /** The last block of the relay's newest complete chunk (its immutable tip, ~k blocks behind the tip). */
    private async chunkStart(chunkSlots: number): Promise<Point> {
        if (!this.lq || !this.stats.lightQuery) throw new Error("the chunk start needs the relay's light-query protocol (GetChunk)");
        const tipChunk = Math.floor((this.stats.serverTip?.slot ?? 0) / chunkSlots);
        for (let n = tipChunk - 1; n >= Math.max(0, tipChunk - 40); n--) {
            const files = await this.guard(this.lq.chunk(n));
            if (!files) continue;
            const p = lastPointOfChunk(files.primary, files.secondary);
            if (p) { this.log(`starting at the end of the relay's chunk ${n}: slot ${p.slot}`); return p; }
        }
        throw new Error("the relay offered no complete chunk near its tip");
    }

    private teardown(): void {
        this.txc?.dispose(); this.txc = null;
        this.lq?.dispose(); this.lq = null;
        try { this.mux?.close({ closeSocket: true }); } catch { /* ignore */ }
        try { this.socket?.close(); } catch { /* ignore */ }
        this.mux = null; this.socket = null;
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.stats.state = "stopped";
        this.closeWith(new ConnectionClosed("stopped"));
        this.teardown();
        this.emit();
    }
}
