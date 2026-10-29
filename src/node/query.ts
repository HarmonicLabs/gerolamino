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
import type { LedgerOut } from "./ledgerApply";
import type { LocalLedger } from "./ledgerStore";
import { toHex } from "@harmoniclabs/uint8array-utils";

export type QuerySource = "local" | "relay" | "none";

export interface QueryAnswer {
    source: QuerySource;
    status: number;
    body: unknown;
    /** The Gerolamo peer that answered (relay answers). */
    peer?: string;
    /** Where this local ledger answer is complete from (`/txs/{hash}/utxos`, `/utxo/...`, genesis coverage). */
    ledger?: { startSlot: number | null; kind: "verified-start" | "snapshot" | "genesis"; tipSlot: number | null };
    ms: number;
}

export interface QueryContext {
    index: LocalChainIndex;
    network: NetworkParams;
    /** Ask the connected Gerolamo peer; undefined when no peer serves queries. */
    relay?: (path: string) => Promise<{ status: number; body: string }>;
    peer?: string;
    /** The local UTxO ledger: tx-scoped and genesis-coverage answers use it before the relay. */
    ledger?: LocalLedger;
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
    if (local) {
        const ledgerPaths = /^\/txs\/[^/]+\/utxos$|^\/utxo\/|^\/addresses\//;
        return { source: "local", status: 200, body: local, ledger: ctx.ledger && ledgerPaths.test(path) ? ctx.ledger.answerCoverage() : undefined, ms: Date.now() - t0 };
    }
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
    if (seg[0] === "txs" && seg.length === 3 && seg[2] === "utxos") return txUtxosDoc(ctx, seg[1]!);
    if (seg[0] === "utxo" && seg.length === 2) return utxoDoc(ctx, decodeUtxoRef(seg[1]!) ?? "");
    if (seg[0] === "addresses" && seg.length === 3 && seg[2] === "utxos") return addressUtxosDoc(ctx, seg[1]!);
    return null;
}

/** UTxO ref `txid:index` with a valid txid; null for anything else (the relay gets the path then). */
function decodeUtxoRef(s: string): string | null {
    return /^[0-9a-f]{64}:\d+$/.test(s) ? s : null;
}

/** The Blockfrost UTXO shape from a local ledger output (spent ones carry `spent_boolean`). */
function ledgerOutDoc(o: LedgerOut): Record<string, unknown> {
    const amount = [{ unit: "lovelace", quantity: o.lovelace }];
    for (const a of o.assets) amount.push({ unit: a.policy + a.name, quantity: a.quantity });
    return {
        tx_hash: o.txHash,
        output_index: Number(o.ref.slice(65)),
        address: o.address,
        amount,
        spent_boolean: o.spentSlot != null,
        ...(o.datumHash ? { data_hash: o.datumHash } : {}),
        ...(o.inlineDatum ? { inline_datum: o.inlineDatum } : {}),
        ...(o.scriptRefHash ? { reference_script_hash: o.scriptRefHash } : {}),
    };
}

/** Outputs of a stored transaction: complete for that tx only when the ledger covers its slot. */
function txUtxosDoc(ctx: QueryContext, txHash: string): unknown[] | null {
    const outs = ctx.ledger?.txOutputs(txHash);
    if (!outs || !outs.length || ctx.ledger!.coverage.stale) return null;
    const start = ctx.ledger!.coverage.startSlot;
    if (start == null || outs.some((o) => o.createdSlot < start)) return null;
    const e = ctx.index.tx(txHash);
    if (e && e.block.slot < start) return null;
    return outs.map(ledgerOutDoc);
}

/** `/utxo/{txid:index}`: the unspent output, or null (the relay answers spent/older refs). */
function utxoDoc(ctx: QueryContext, ref: string): Record<string, unknown> | null {
    if (!ctx.ledger || ctx.ledger.coverage.stale) return null;
    const o = ctx.ledger.utxo(ref);
    return o ? ledgerOutDoc(o) : null;
}

/** Address UTxOs only when the ledger covers from slot 0 (P1 snapshot/genesis); otherwise relay. */
function addressUtxosDoc(ctx: QueryContext, address: string): unknown[] | null {
    if (!ctx.ledger || ctx.ledger.coverage.startSlot !== 0 || ctx.ledger.coverage.stale) return null;
    return ctx.ledger.addressUtxos(address).map(ledgerOutDoc);
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
