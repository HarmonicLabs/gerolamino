/**
 * Blockfrost-shaped queries answered local-first. What the stored, verified blocks contain is answered from the
 * local index (localIndex.ts); everything else, and anything before the node's start point, is asked of a Gerolamo
 * peer through the light-query protocol (`[8, id, path]` → `[9, id, status, body]`), which answers from its full
 * ledger with its own Blockfrost API. Every answer says where it came from.
 *
 * Local paths (same JSON shape as Blockfrost, fields a block's bytes determine):
 *   /blocks/latest, /blocks/{hash_or_number}, /blocks/{hash_or_number}/txs, /txs/{hash}
 */
import type { NetworkParams } from "./networks";
import { epochOfSlot, epochSlotOf, slotToUnix } from "./networks";
import { poolIdOf, vrfKeyOf, type IndexedBlock, type IndexedTx, type LocalChainIndex } from "./localIndex";
import { toHex } from "@harmoniclabs/uint8array-utils";

export type QuerySource = "local" | "relay" | "none";

export interface QueryAnswer {
    source: QuerySource;
    status: number;
    body: unknown;
    /** The Gerolamo peer that answered (relay answers). */
    peer?: string;
    ms: number;
}

export interface QueryContext {
    index: LocalChainIndex;
    network: NetworkParams;
    /** Ask the connected Gerolamo peer; undefined when no peer serves queries. */
    relay?: (path: string) => Promise<{ status: number; body: string }>;
    peer?: string;
}

/** `path` as Blockfrost writes it, without the `/api/v0` prefix: "/blocks/latest". */
export function normalizePath(path: string): string {
    let p = path.trim();
    if (/^https?:\/\//i.test(p)) { try { const u = new URL(p); p = u.pathname + u.search; } catch { /* keep */ } }
    if (!p.startsWith("/")) p = "/" + p;
    p = p.replace(/^\/api\/v0(?=\/|$)/, "") || "/";
    return p.length > 1 ? p.replace(/\/+$/, "") || "/" : p;
}

export async function answerQuery(rawPath: string, ctx: QueryContext): Promise<QueryAnswer> {
    const t0 = Date.now();
    const path = normalizePath(rawPath);
    const local = answerLocally(path, ctx);
    if (local) return { source: "local", status: 200, body: local, ms: Date.now() - t0 };
    if (!ctx.relay) {
        return { source: "none", status: 503, body: { status_code: 503, error: "Service Unavailable", message: "not in the local store, and no Gerolamo peer that answers queries is connected" }, ms: Date.now() - t0 };
    }
    const r = await ctx.relay(path);
    let body: unknown = r.body;
    try { body = JSON.parse(r.body); } catch { /* not JSON: keep the text */ }
    return { source: "relay", status: r.status, body, peer: ctx.peer, ms: Date.now() - t0 };
}

/** The local answer, or null when the index cannot answer (unknown path, or data it does not hold). */
export function answerLocally(path: string, ctx: QueryContext): unknown | null {
    const [p] = path.split("?");
    const seg = p!.split("/").filter(Boolean);
    const { index } = ctx;
    if (seg[0] === "blocks" && seg.length === 2 && seg[1] === "latest") return index.tip ? blockDoc(index.tip, ctx) : null;
    if (seg[0] === "blocks" && seg.length === 2) { const b = index.block(seg[1]!); return b ? blockDoc(b, ctx) : null; }
    if (seg[0] === "blocks" && seg.length === 3 && seg[2] === "txs") { const b = index.block(seg[1]!); return b ? b.txs.map((t) => t.hash) : null; }
    if (seg[0] === "txs" && seg.length === 2) { const e = index.tx(seg[1]!); return e ? txDoc(e.block, e.tx, ctx) : null; }
    return null;
}

function blockDoc(b: IndexedBlock, { index, network }: QueryContext): Record<string, unknown> {
    const next = index.next(b);
    const tip = index.tip;
    return {
        time: slotToUnix(network, b.slot),
        height: b.height,
        hash: b.hash,
        slot: b.slot,
        epoch: epochOfSlot(network, b.slot),
        epoch_slot: epochSlotOf(network, b.slot),
        slot_leader: poolIdOf(b.issuerVkey),
        size: b.size,
        tx_count: b.txs.length,
        output: b.txs.filter((t) => t.valid).reduce((a, t) => a + t.outputLovelace, 0n).toString(),
        fees: b.txs.filter((t) => t.valid).reduce((a, t) => a + t.fees, 0n).toString(),
        block_vrf: vrfKeyOf(b.vrfVkey),
        op_cert: toHex(b.opCert.hotVkey),
        op_cert_counter: b.opCert.counter.toString(),
        previous_block: b.prevHash,
        next_block: next ? next.hash : null,
        // relative to this node's tip, which may trail the network's
        confirmations: tip ? tip.height - b.height : 0,
    };
}

function txDoc(b: IndexedBlock, t: IndexedTx, { network }: QueryContext): Record<string, unknown> {
    return {
        hash: t.hash,
        block: b.hash,
        block_height: b.height,
        block_time: slotToUnix(network, b.slot),
        slot: b.slot,
        index: t.index,
        output_amount: [{ unit: "lovelace", quantity: t.outputLovelace.toString() },
            // Blockfrost lists assets by unit, ascending
            ...[...t.outputAssets].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([unit, q]) => ({ unit, quantity: q.toString() }))],
        fees: t.fees.toString(),
        size: t.size,
        invalid_before: t.invalidBefore?.toString() ?? null,
        invalid_hereafter: t.invalidHereafter?.toString() ?? null,
        utxo_count: t.inputs + t.outputs,
        withdrawal_count: t.withdrawals,
        mir_cert_count: t.mirCerts,
        pool_update_count: t.poolUpdates,
        pool_retire_count: t.poolRetires,
        asset_mint_or_burn_count: t.mintAssets,
        redeemer_count: t.redeemers,
        valid_contract: t.valid,
        treasury_donation: t.donation.toString(),
    };
}
