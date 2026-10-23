/**
 * What Gerolamino can answer about the chain from the blocks it verified and stored itself, without a ledger: per
 * block its header facts and per transaction what its bytes say (fee, outputs, validity interval, counts). Built from
 * the stored block bytes with the minimal CBOR walker (cbor.ts), so it needs nothing beyond the block. Everything
 * else (UTxO set, balances, pools, deposits) is ledger state, which a tip- or Mithril-started browser node does not
 * have; query.ts asks a Gerolamo peer for it.
 */
import { blake2b_224, blake2b_256, encodeBech32 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import { arrayElements, bytesAt, countAt, mapEntries, uintAt, untag } from "./cbor";

export interface IndexedTx {
    hash: string;
    index: number;
    size: number;
    fees: bigint;
    /** Sum of every output: lovelace and each asset (`policy ‖ name` hex). */
    outputLovelace: bigint;
    outputAssets: Map<string, bigint>;
    inputs: number;
    outputs: number;
    invalidBefore: bigint | null;
    invalidHereafter: bigint | null;
    withdrawals: number;
    mintAssets: number;
    redeemers: number;
    mirCerts: number;
    poolUpdates: number;
    poolRetires: number;
    donation: bigint;
    /** false for a transaction the block marks invalid (phase-2 failure: collateral taken). */
    valid: boolean;
}

export interface IndexedBlock {
    hash: string;
    height: number;
    slot: number;
    prevHash: string | null;
    /** Stored size of the block (`[era, block]` bytes), what Blockfrost reports as `size`. */
    size: number;
    eraTag: number;
    issuerVkey: Uint8Array;
    vrfVkey: Uint8Array;
    opCert: { hotVkey: Uint8Array; counter: bigint };
    txs: IndexedTx[];
}

const range = (b: Uint8Array, r: { start: number; end: number }) => b.subarray(r.start, r.end);

/** Every fact of one stored block (`[eraTag, [header, bodies, witnesses, auxiliary, invalid?]]`, Shelley era and later). */
export function indexBlock(block: Uint8Array): IndexedBlock {
    const outer = arrayElements(block, 0);
    const eraTag = Number(uintAt(block, outer[0]!.start));
    if (eraTag < 2) throw new Error("Byron blocks are not indexed");
    const parts = arrayElements(block, outer[1]!.start);
    // header = [header_body, kes_signature]
    const header = range(block, parts[0]!);
    const hb = arrayElements(block, arrayElements(block, parts[0]!.start)[0]!.start);
    const babbage = eraTag >= 6;
    const opCert = babbage
        ? (() => { const oc = arrayElements(block, hb[8]!.start); return { hotVkey: bytesAt(block, oc[0]!.start), counter: uintAt(block, oc[1]!.start) }; })()
        : { hotVkey: bytesAt(block, hb[9]!.start), counter: uintAt(block, hb[10]!.start) };
    const prevAt = hb[2]!.start;
    const bodies = arrayElements(block, parts[1]!.start);
    const wits = arrayElements(block, parts[2]!.start);
    const aux = new Map<number, number>(mapEntries(block, parts[3]!.start).map(({ k, v }) => [Number(uintAt(block, k.start)), v.end - v.start]));
    const invalid = new Set<number>(eraTag >= 5 && parts[4] ? arrayElements(block, untag(block, parts[4].start)).map((r) => Number(uintAt(block, r.start))) : []);
    const txs = bodies.map((r, i) => indexTx(block, r, wits[i]!, aux.get(i) ?? 0, i, !invalid.has(i)));
    return {
        hash: toHex(blake2b_256(header)),
        height: Number(uintAt(block, hb[0]!.start)),
        slot: Number(uintAt(block, hb[1]!.start)),
        prevHash: block[prevAt] === 0xf6 ? null : toHex(bytesAt(block, prevAt)),
        size: block.length,
        eraTag,
        issuerVkey: bytesAt(block, hb[3]!.start),
        vrfVkey: bytesAt(block, hb[4]!.start),
        opCert,
        txs,
    };
}

function indexTx(b: Uint8Array, body: { start: number; end: number }, wit: { start: number; end: number }, auxLen: number, index: number, valid: boolean): IndexedTx {
    const tx: IndexedTx = {
        hash: toHex(blake2b_256(range(b, body))), index,
        // the transaction as cardano-ledger serialises it: [body, witnesses, is_valid, auxiliary_data / null]
        size: 1 + (body.end - body.start) + (wit.end - wit.start) + 1 + (auxLen || 1),
        fees: 0n, outputLovelace: 0n, outputAssets: new Map(), inputs: 0, outputs: 0, invalidBefore: null, invalidHereafter: null,
        withdrawals: 0, mintAssets: 0, redeemers: 0, mirCerts: 0, poolUpdates: 0, poolRetires: 0, donation: 0n, valid,
    };
    for (const { k, v } of mapEntries(b, body.start)) {
        const key = Number(uintAt(b, k.start));
        switch (key) {
            case 0: tx.inputs = countAt(b, v.start); break;
            case 1: for (const o of arrayElements(b, v.start)) { tx.outputs++; addValue(tx, b, outputValueAt(b, o.start)); } break;
            case 2: tx.fees = uintAt(b, v.start); break;
            case 3: tx.invalidHereafter = uintAt(b, v.start); break;
            case 4: for (const c of arrayElements(b, untag(b, v.start))) {
                const tag = Number(uintAt(b, arrayElements(b, c.start)[0]!.start));
                if (tag === 3) tx.poolUpdates++; else if (tag === 4) tx.poolRetires++; else if (tag === 6) tx.mirCerts++;
            } break;
            case 5: tx.withdrawals = countAt(b, v.start); break;
            case 8: tx.invalidBefore = uintAt(b, v.start); break;
            case 9: for (const p of mapEntries(b, v.start)) tx.mintAssets += countAt(b, p.v.start); break;
            case 22: tx.donation = uintAt(b, v.start); break;
        }
    }
    for (const { k, v } of mapEntries(b, wit.start)) if (Number(uintAt(b, k.start)) === 5) tx.redeemers = countAt(b, v.start);
    return tx;
}

/** Position of an output's value: legacy `[address, value, ...]` or Babbage `{0: address, 1: value, ...}`. */
function outputValueAt(b: Uint8Array, p: number): number {
    if (b[p]! >> 5 === 4) return arrayElements(b, p)[1]!.start;
    const e = mapEntries(b, p).find(({ k }) => Number(uintAt(b, k.start)) === 1);
    if (!e) throw new Error("output without a value");
    return e.v.start;
}

/** `coin` or `[coin, {policy: {name: quantity}}]`. */
function addValue(tx: IndexedTx, b: Uint8Array, p: number): void {
    if (b[p]! >> 5 === 0) { tx.outputLovelace += uintAt(b, p); return; }
    const [coin, ma] = arrayElements(b, p);
    tx.outputLovelace += uintAt(b, coin!.start);
    for (const pol of mapEntries(b, ma!.start)) {
        const policy = toHex(bytesAt(b, pol.k.start));
        for (const a of mapEntries(b, pol.v.start)) {
            const unit = policy + toHex(bytesAt(b, a.k.start));
            tx.outputAssets.set(unit, (tx.outputAssets.get(unit) ?? 0n) + uintAt(b, a.v.start));
        }
    }
}

/** Bech32 forms Blockfrost uses for the block producer and its VRF key. */
export const poolIdOf = (issuerVkey: Uint8Array) => encodeBech32("pool", blake2b_224(issuerVkey));
export const vrfKeyOf = (vrfVkey: Uint8Array) => encodeBech32("vrf_vk", vrfVkey);

/**
 * The stored blocks, by hash and height, and their transactions by hash. Follows the store: blocks are added as they
 * are verified and stored, dropped on rollback, and at most `maxBlocks` are kept (oldest dropped first).
 */
export class LocalChainIndex {
    private readonly byHash = new Map<string, IndexedBlock>();
    private readonly byHeight = new Map<number, string>();
    private readonly txs = new Map<string, { block: IndexedBlock; tx: IndexedTx }>();
    private order: string[] = [];

    constructor(readonly maxBlocks = 50_000) {}

    get size(): number { return this.order.length; }
    get tip(): IndexedBlock | null { const h = this.order[this.order.length - 1]; return h ? this.byHash.get(h)! : null; }

    /** Index one stored block; returns null for a block that cannot be indexed (Byron, malformed). */
    add(block: Uint8Array): IndexedBlock | null {
        let ib: IndexedBlock;
        try { ib = indexBlock(block); } catch { return null; }
        if (this.byHash.has(ib.hash)) return ib;
        this.byHash.set(ib.hash, ib);
        this.byHeight.set(ib.height, ib.hash);
        for (const tx of ib.txs) this.txs.set(tx.hash, { block: ib, tx });
        this.order.push(ib.hash);
        while (this.order.length > this.maxBlocks) this.remove(this.order.shift()!);
        return ib;
    }

    /** Drop every block after `slot` (a chain-sync rollback). */
    rollbackTo(slot: number): number {
        let n = 0;
        while (this.order.length && this.byHash.get(this.order[this.order.length - 1]!)!.slot > slot) { this.remove(this.order.pop()!); n++; }
        return n;
    }

    clear(): void { this.byHash.clear(); this.byHeight.clear(); this.txs.clear(); this.order = []; }

    block(id: string): IndexedBlock | null {
        if (/^[0-9a-f]{64}$/i.test(id)) return this.byHash.get(id.toLowerCase()) ?? null;
        if (/^\d+$/.test(id)) { const h = this.byHeight.get(Number(id)); return h ? this.byHash.get(h)! : null; }
        return null;
    }

    /** The block after `b` in the index (Blockfrost's `next_block`), when it is stored. */
    next(b: IndexedBlock): IndexedBlock | null { const h = this.byHeight.get(b.height + 1); const n = h ? this.byHash.get(h)! : null; return n && n.prevHash === b.hash ? n : null; }

    tx(hash: string): { block: IndexedBlock; tx: IndexedTx } | null { return this.txs.get(hash.toLowerCase()) ?? null; }

    private remove(hash: string): void {
        const b = this.byHash.get(hash);
        if (!b) return;
        this.byHash.delete(hash);
        if (this.byHeight.get(b.height) === hash) this.byHeight.delete(b.height);
        for (const tx of b.txs) if (this.txs.get(tx.hash)?.block === b) this.txs.delete(tx.hash);
    }
}

/**
 * Index the blocks already in the store (chunk files from an earlier session), newest `maxChunks` chunks only so a
 * long-running store does not delay the start. Returns the number of blocks indexed.
 */
export async function loadIndexFromStore(
    sink: { list(): Promise<string[]>; read(name: string): Promise<Uint8Array | null> },
    index: LocalChainIndex,
    maxChunks = 40,
): Promise<number> {
    const { SECONDARY_ENTRY_SIZE, decodeSecondaryEntry, chunkFileName } = await import("./chunkFormat");
    const chunkNos = (await sink.list())
        .map((n) => /^(\d{5})\.chunk$/.exec(n)?.[1])
        .filter((n): n is string => !!n)
        .map(Number)
        .sort((a, b) => a - b)
        .slice(-maxChunks);
    let added = 0;
    for (const no of chunkNos) {
        const [chunk, sec] = await Promise.all([sink.read(chunkFileName(no, "chunk")), sink.read(chunkFileName(no, "secondary"))]);
        if (!chunk || !sec) continue;
        const n = Math.floor(sec.length / SECONDARY_ENTRY_SIZE);
        for (let i = 0; i < n; i++) {
            const start = decodeSecondaryEntry(sec, i).blockOffset;
            const end = i + 1 < n ? decodeSecondaryEntry(sec, i + 1).blockOffset : chunk.length;
            if (index.add(chunk.subarray(start, end))) added++;
        }
    }
    return added;
}
