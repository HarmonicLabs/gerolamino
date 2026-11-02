/**
 * P2 ledger-rule core for Gerolamino's local ledger. It is deliberately explicit about its scope:
 * one transaction's value conservation, input uniqueness/existence, negative outputs and a
 * protocol minimum fee. Stake deposits, withdrawals from reward accounts, governance deposits,
 * epoch rewards and full era rule sets are reported separately by the caller; P2 is not consensus
 * parity (P3 adds phase-2 script execution and more exact checks).
 *
 * Units are strings: `lovelace` or `policyHex.nameHex`, so no asset can silently merge with another.
 */
import { toHex } from "@harmoniclabs/uint8array-utils";
import type { LedgerOut } from "./ledgerApply";

export interface LedgerRuleParams {
    minFeeA: number;
    minFeeB: number;
    keyDeposit: bigint;
    poolDeposit: bigint;
    minUTxOValue: bigint;
    maxTxSize?: number;
}

export interface LedgerRuleOutcome {
    failures: string[];
    reports: string[];
    inputs: number;
    outputs: number;
    fees: bigint;
    minted: string[];
    withdrawals: bigint;
}

type Units = Map<string, bigint>;
export const unitsOfLovelace = (n: bigint): Units => new Map([["lovelace", n]]);
export function unitsOfOut(o: LedgerOut): Units {
    const m: Units = new Map([["lovelace", BigInt(o.lovelace)]]);
    for (const a of o.assets) addUnit(m, `${a.policy}${a.name}`, BigInt(a.quantity));
    return m;
}
export function addUnit(m: Units, unit: string, n: bigint): void {
    if (n === 0n) return;
    m.set(unit, (m.get(unit) ?? 0n) + n);
}
export function addUnits(m: Units, other: Units): void { for (const [u, n] of other) addUnit(m, u, n); }
export function unitsEqual(a: Units, b: Units): boolean {
    if (a.size !== b.size) return false;
    for (const [u, n] of a) if (b.get(u) !== n) return false;
    return true;
}
export function unitsDiff(consumed: Units, produced: Units): string {
    const out: string[] = [];
    for (const [u, n] of consumed) { const d = n - (produced.get(u) ?? 0n); if (d !== 0n) out.push(`${u}:${d}`); }
    for (const [u, n] of produced) if (!consumed.has(u)) out.push(`${u}:${-n}`);
    return out.slice(0, 6).join(", ");
}

/** Lovelace / assets of a raw ledger-ts Value or output. */
export function unitsOfValue(value: any): Units {
    if (!value) return new Map();
    const m = unitsOfLovelace(BigInt(value?.lovelaces?.toString?.() ?? value?.lovelaces ?? 0n));
    for (const entry of (value?.map ?? [])) {
        const policy = String(entry.policy?.toString?.() ?? entry.policy ?? "").toLowerCase();
        if (!policy) continue;
        for (const a of (entry.assets ?? [])) {
            const name = toHex(a.name ?? new Uint8Array(0));
            addUnit(m, `${policy}${name}`, BigInt(a.quantity?.toString?.() ?? a.quantity ?? 0n));
        }
    }
    return m;
}

/** One transaction body's P2 core checks; `resolve(ref)` must return the stored row (spent or unspent). */
export function checkTransactionCore(body: any, resolve: (ref: string) => LedgerOut | null, params: LedgerRuleParams): LedgerRuleOutcome {
    const failures: string[] = [];
    const reports: string[] = [];
    const consumed = new Map<string, bigint>();
    const produced = new Map<string, bigint>();
    const seen = new Set<string>();
    let inputs = 0;
    for (const input of (body.inputs ?? [])) {
        let ref = "";
        try {
            ref = `${String(input.utxoRef.id.toString()).toLowerCase()}:${Number(input.utxoRef.index)}`;
        } catch { failures.push("malformed input"); continue; }
        if (!/^[0-9a-f]{64}:\d+$/.test(ref)) { failures.push(`malformed input ${ref}`); continue; }
        if (seen.has(ref)) failures.push(`duplicate input ${ref}`);
        seen.add(ref);
        inputs++;
        const row = resolve(ref);
        if (!row) { failures.push(`spent ${ref} not found in the ledger`); continue; }
        if (row.spentSlot != null) failures.push(`input ${ref} already spent at ${row.spentSlot}`);
        addUnits(consumed, unitsOfOut(row));
    }
    const minted: string[] = [];
    const mintEntries = Array.isArray(body.mint) ? body.mint : (body.mint?.map ?? []);
    for (const entry of mintEntries) {
        const policy = String(entry.policy?.toString?.() ?? entry.policy ?? "").toLowerCase();
        if (!policy) continue;
        for (const a of entry.assets ?? []) {
            const name = toHex(a.name ?? new Uint8Array(0));
            const q = BigInt(a.quantity?.toString?.() ?? a.quantity ?? 0n);
            addUnit(consumed, `${policy}${name}`, q);
            minted.push(`${policy}${name}:${q}`);
        }
    }
    let withdrawals = 0n;
    for (const w of ((body.withdrawals?.map ?? []) as any[])) {
        const amount = BigInt(w.amount?.toString?.() ?? w.amount ?? 0n);
        withdrawals += amount;
        addUnit(consumed, "lovelace", amount);
    }
    let outputs = 0;
    for (const o of (body.outputs ?? [])) {
        outputs++;
        const u = unitsOfValue(o.value);
        for (const [unit, n] of u) if (n < 0n) failures.push(`negative output quantity ${unit.slice(0, 18)}`);
        addUnits(produced, u);
    }
    let fees = 0n;
    try { fees = BigInt(body.fee?.toString?.() ?? body.fee ?? 0n); } catch { failures.push("malformed fee"); }
    addUnit(produced, "lovelace", fees);
    let deposits = 0n, refunds = 0n;
    for (const c of ((body.certs ?? []) as any[])) {
        try {
            const tag = Number(c?.__typename ?? c?.type ?? c?.tag ?? -1);
            const deposit = tag >= 0 && tag <= 5 ? params.keyDeposit : tag >= 6 && tag <= 8 ? params.poolDeposit : 0n;
            if (deposit > 0n) deposits += deposit;
        } catch { /* cert shapes are era-specific; reported by the caller */ }
    }
    addUnit(produced, "lovelace", deposits);
    addUnit(consumed, "lovelace", refunds);
    if (!unitsEqual(consumed, produced)) failures.push(`value not conserved: ${unitsDiff(consumed, produced)}`);

    let txSize: number | null = null;
    try { txSize = body?.cborRef?.toBuffer?.()?.length ?? null; } catch { txSize = null; }
    if (txSize == null) reports.push("fee minimum not checked: transaction size unknown");
    else {
        const min = BigInt(params.minFeeA * txSize + params.minFeeB);
        if (fees < min) failures.push(`fee ${fees} below minimum ${min} (size ${txSize})`);
        if (params.maxTxSize != null && txSize > params.maxTxSize) failures.push(`transaction size ${txSize} > ${params.maxTxSize}`);
    }
    const depositsTotal = deposits;
    if (depositsTotal > 0n) reports.push(`certificate deposits counted: ${depositsTotal}; refunds/reward balances are P2 exactness work`);
    return { failures, reports, inputs, outputs, fees, minted, withdrawals };
}

/** Async variant because ledger-ts block parsing is imported lazily. */
export async function checkBlockCoreRulesAsync(bytes: Uint8Array, resolve: (ref: string) => LedgerOut | null, params: LedgerRuleParams): Promise<{ failures: string[]; reports: string[]; txs: number; fees: bigint; withdrawals: bigint }> {
    const { MultiEraBlock } = await import("@harmoniclabs/cardano-ledger-ts");
    const block: any = MultiEraBlock.fromCbor(bytes).block;
    const bodies: any[] = Array.isArray(block?.transactionBodies) ? block.transactionBodies : [];
    const failures: string[] = [], reports: string[] = [];
    let fees = 0n, withdrawals = 0n;
    for (const body of bodies) {
        const r = checkTransactionCore(body, resolve, params);
        failures.push(...r.failures.slice(0, 4));
        reports.push(...r.reports.slice(0, 2));
        fees += r.fees; withdrawals += r.withdrawals;
    }
    return { failures, reports, txs: bodies.length, fees, withdrawals };
}
