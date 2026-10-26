/**
 * Client side of the Gerolamo light-query mini-protocol (mux protocol 7 on N2N connections): the epoch nonce, a
 * pool's active stake and complete immutable chunks, requested over the same WebSocket as chain-sync and
 * block-fetch, so a browser node needs nothing but the relay's N2N endpoint. Wire (one CBOR array per message):
 *
 *   [4]                      → [5, networkMagic, version, capabilities?]                        hello (version 1
 *                                adds the capability map: the request types the peer serves and their limits)
 *   [0, epoch]               → [1, epoch, nonce(32) | null]                                     η0
 *   [2, epoch, poolId(28)]   → [3, epoch, poolStake | null, totalActiveStake | null, f.num, f.den]
 *   [6, chunkNo]             → [7, chunkNo, chunk, primary, secondary] | [7, chunkNo, null, null, null]
 *   [8, id, path]            → [9, id, status, body]    a Blockfrost GET (path under /api/v0) answered by the peer
 *   [10, from, to]           → [11, from, to, [[name, sha256], …] | null]   Mithril digests of the peer's immutable
 *                                files numbered from..to (`to` in the reply: where the page ends; null: not ready)
 *   anything else            → [255, text]               (a peer without a request type answers this)
 */
import { Cbor, CborArray, CborBytes, CborMap, CborSimple, CborText, CborUInt, type CborObj } from "@harmoniclabs/cbor";
import type { Multiplexer } from "@harmoniclabs/ouroboros-miniprotocols-ts";

/**
 * Mux protocol number. The multiplexer library only forwards known mini-protocol numbers, so the
 * light query rides on 7 (the node-to-client LocalStateQuery number), which never appears on a
 * node-to-node connection: cardano-nodes do not open it there and Gerolamo hosts nothing else on it.
 */
export const LIGHT_QUERY_PROTOCOL = 7;

/**
 * WebSocket subprotocols a peer selects to announce its services before any N2N byte (CIP draft in the Gerolamo
 * repository, CIP/): standard N2N only, or with the light query. A browser offers both, best first.
 */
export const N2N_WS_SUBPROTOCOL = "cardano-n2n.v1";
export const N2N_WS_SUBPROTOCOL_LIGHTQUERY = "cardano-n2n.v1+lightquery";

/** What a peer's light-query hello announces (version 1); null for a version-0 peer, which announces nothing. */
export interface LightQueryCapabilities {
    nonce: boolean;
    stake: boolean;
    chunk: boolean;
    /** Mithril digests of the peer's immutable files (request 10). */
    digests: boolean;
    blockfrost: { rate: number; windowMs: number; maxBody: number } | null;
}

export function parseCapabilities(m: CborObj | undefined): LightQueryCapabilities | null {
    if (!(m instanceof CborMap)) return null;
    const get = (map: CborMap, k: string) => map.map.find((e) => e.k instanceof CborText && e.k.text === k)?.v;
    const flag = (k: string) => { const v = get(m, k); return v instanceof CborSimple ? v.simple === true : false; };
    const bf = get(m, "blockfrost");
    const n = (k: string) => { const v = bf instanceof CborMap ? get(bf, k) : undefined; return v instanceof CborUInt ? Number(v.num) : 0; };
    return { nonce: flag("nonce"), stake: flag("stake"), chunk: flag("chunk"), digests: flag("digests"), blockfrost: bf instanceof CborMap ? { rate: n("rate"), windowMs: n("window_ms"), maxBody: n("max_body") } : null };
}

export interface PoolStakeInfo {
    epoch: number;
    poolStake: bigint | null;
    totalActiveStake: bigint | null;
    activeSlotsCoeff: { num: bigint; den: bigint };
}

export class LightQueryClient {
    private queue: Array<{ resolve: (m: CborObj) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
    private pending: Uint8Array | null = null;
    private readonly onPayload = (payload: Uint8Array) => this.receive(payload);
    readonly supported: Promise<boolean>;
    /** The peer's announced capabilities once the hello is answered; null for a version-0 peer. */
    capabilities: LightQueryCapabilities | null = null;

    constructor(private readonly mux: Multiplexer, timeoutMs = 10_000) {
        this.mux.on(LIGHT_QUERY_PROTOCOL as any, this.onPayload);
        this.timeoutMs = timeoutMs;
        this.supported = this.hello().then(() => true).catch(() => false);
    }
    private timeoutMs: number;

    /** Detach from the multiplexer and fail every outstanding request (the connection is gone). */
    dispose(): void {
        try { this.mux.off(LIGHT_QUERY_PROTOCOL as any, this.onPayload); } catch { /* ignore */ }
        for (const q of this.queue.splice(0)) { clearTimeout(q.timer); q.reject(new Error("light query: connection closed")); }
    }

    private receive(payload: Uint8Array): void {
        const bytes = this.pending ? concat(this.pending, payload) : payload;
        this.pending = null;
        let off = 0;
        while (off < bytes.length) {
            let p: { parsed: CborObj; offset: number };
            try { p = Cbor.parseWithOffset(bytes.subarray(off)); } catch { this.pending = bytes.slice(off); return; }
            off += p.offset;
            const w = this.queue.shift();
            if (w) { clearTimeout(w.timer); w.resolve(p.parsed); }
        }
    }

    private request(msg: CborObj, timeoutMs = this.timeoutMs): Promise<CborObj> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { const i = this.queue.findIndex((q) => q.timer === timer); if (i >= 0) this.queue.splice(i, 1); reject(new Error("light query timed out")); }, timeoutMs);
            this.queue.push({ resolve, reject, timer });
            this.mux.send(Cbor.encode(msg).toBuffer(), { protocol: LIGHT_QUERY_PROTOCOL as any, hasAgency: true });
        });
    }

    async hello(): Promise<{ magic: number; capabilities: LightQueryCapabilities | null }> {
        const r = await this.request(new CborArray([new CborUInt(4)]));
        const a = (r as CborArray).array;
        if (!(a?.[0] instanceof CborUInt) || Number(a[0].num) !== 5) throw new Error("light query not supported by this relay");
        this.capabilities = parseCapabilities(a[3]);
        return { magic: Number((a[1] as CborUInt).num), capabilities: this.capabilities };
    }

    async epochNonce(epoch: number): Promise<Uint8Array | null> {
        const r = await this.request(new CborArray([new CborUInt(0), new CborUInt(epoch)]));
        const a = (r as CborArray).array;
        if (!(a?.[0] instanceof CborUInt) || Number(a[0].num) !== 1) throw new Error("unexpected light query reply");
        return a[2] instanceof CborBytes ? a[2].bytes : null;
    }

    /** A complete immutable chunk (the three files) from the relay, or null when it does not have it. */
    async chunk(chunkNo: number): Promise<{ chunk: Uint8Array; primary: Uint8Array; secondary: Uint8Array } | null> {
        const r = await this.request(new CborArray([new CborUInt(6), new CborUInt(chunkNo)]), 60_000);
        const a = (r as CborArray).array;
        if (!(a?.[0] instanceof CborUInt) || Number(a[0].num) !== 7) throw new Error("unexpected light query reply");
        if (!(a[2] instanceof CborBytes)) return null;
        return { chunk: (a[2] as CborBytes).bytes, primary: (a[3] as CborBytes).bytes, secondary: (a[4] as CborBytes).bytes };
    }

    /**
     * Mithril digests of the peer's immutable files numbered from..to, as the aggregator lists them; null when the
     * peer does not serve them (not announced) or has not hashed them yet. A page may end before `to` (see `to`).
     */
    async digests(from: number, to: number): Promise<{ from: number; to: number; entries: Array<{ immutable_file_name: string; digest: string }> } | null> {
        if (!this.capabilities?.digests) return null;
        const r = await this.request(new CborArray([new CborUInt(10), new CborUInt(from), new CborUInt(to)]), 60_000);
        const a = (r as CborArray).array;
        if (!(a?.[0] instanceof CborUInt) || Number(a[0].num) !== 11) throw new Error("unexpected light query reply");
        if (!(a[3] instanceof CborArray)) return null;
        const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
        const entries = a[3].array.map((e) => {
            const [name, digest] = (e as CborArray).array;
            if (!(name instanceof CborText) || !(digest instanceof CborBytes) || digest.bytes.length !== 32) throw new Error("bad digest entry");
            return { immutable_file_name: name.text, digest: hex(digest.bytes) };
        });
        return { from: Number((a[1] as CborUInt).num), to: Number((a[2] as CborUInt).num), entries };
    }

    private nextQueryId = 1;

    /**
     * A Blockfrost GET answered by the peer from its full ledger (`path` under /api/v0, "/addresses/…/utxos").
     * Throws QueryUnsupported when the peer predates the request (it answers [255]).
     */
    async query(path: string, timeoutMs = 20_000): Promise<{ status: number; body: string }> {
        // a peer that announces its capabilities is asked only for what it lists
        if (this.capabilities && !this.capabilities.blockfrost) throw new QueryUnsupported();
        const id = this.nextQueryId++;
        const r = await this.request(new CborArray([new CborUInt(8), new CborUInt(id), new CborText(path)]), timeoutMs);
        const a = (r as CborArray).array;
        const tag = a?.[0] instanceof CborUInt ? Number(a[0].num) : -1;
        if (tag === 255) throw new QueryUnsupported();
        if (tag !== 9 || !(a[2] instanceof CborUInt) || !(a[3] instanceof CborText)) throw new Error("unexpected light query reply");
        return { status: Number(a[2].num), body: a[3].text };
    }

    async poolStake(epoch: number, poolId: Uint8Array): Promise<PoolStakeInfo> {
        const r = await this.request(new CborArray([new CborUInt(2), new CborUInt(epoch), new CborBytes(poolId)]));
        const a = (r as CborArray).array;
        if (!(a?.[0] instanceof CborUInt) || Number(a[0].num) !== 3) throw new Error("unexpected light query reply");
        const u = (x: CborObj | undefined) => (x instanceof CborUInt ? BigInt(x.num) : null);
        return { epoch, poolStake: u(a[2]), totalActiveStake: u(a[3]), activeSlotsCoeff: { num: u(a[4]) ?? 5n, den: u(a[5]) ?? 100n } };
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }

/** The peer speaks the light query but not Blockfrost queries (an older Gerolamo). */
export class QueryUnsupported extends Error {
    constructor() { super("this peer does not answer Blockfrost queries"); }
}
