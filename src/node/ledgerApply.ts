/**
 * UTxO projection for Gerolamino's local ledger (docs/LEDGER_SPEC.md P0): what a verified block does to the
 * UTxO set, read from the block's own bytes with cardano-ledger-ts. Phase-2 invalid transactions spend only
 * their collateral and create only a collateral return; ordinary transactions spend their inputs and create
 * their outputs. Reference inputs are not spent by ordinary inputs. Script execution, fees, stake and
 * governance effects stay out (P2); this is a light-node projection, not consensus validation.
 */
import { Cbor, CborArray, CborBytes, CborMap, CborObj, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_224, blake2b_256 } from "@harmoniclabs/crypto";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { toHex } from "@harmoniclabs/uint8array-utils";

export interface LedgerAsset { policy: string; name: string; quantity: string }
export interface LedgerOut {
    ref: string;
    txHash: string;
    address: string;
    addressBytes: string;
    lovelace: string;
    assets: LedgerAsset[];
    datumHash?: string;
    inlineDatum?: string;
    scriptRefHash?: string;
    stakeKey?: string;
    createdSlot: number;
    spentSlot: number | null;
}

export interface LedgerBlockDiff {
    format: 1;
    slot: number;
    hash: string;
    txs: number;
    invalidTx: number[];
    created: LedgerOut[];
    spent: string[];
    unknownInputs: string[];
    /** P2 deltas (fees/deposits/withdrawals/stake/gov); optional for old logs. */
    p2?: LedgerP2Diff;
}

export interface LedgerP2Diff {
    fees: string; deposits: string; withdrawals: string; treasury: string; donation: string;
    minted: string[];
    stakeRegistered: string[]; stakeUnregistered: string[]; stakeDelegations: Array<[string, string]>;
    poolRegistrations: string[]; poolRetirements: string[]; governanceDeposits: string[];
}

export interface LedgerP2State {
    fees: string; deposits: string; withdrawals: string; treasury: string; donation: string;
    minted: string[];
    stakeRegistered: string[]; stakeUnregistered: string[]; stakeDelegations: Array<[string, string]>;
    poolRegistrations: string[]; poolRetirements: string[]; governanceDeposits: string[];
}

/** Raw bytes of a ledger-ts Address from the CBOR slice it was parsed from (null when unavailable). */
function rawAddressBytesOf(a: any): Uint8Array | null {
    try {
        const ref = a?.cborRef;
        const bytes: Uint8Array | undefined = ref?._bytes;
        if (!bytes || typeof ref.start !== "number" || typeof ref.end !== "number") return null;
        const slice = new Uint8Array(bytes.buffer, bytes.byteOffset + ref.start, ref.end - ref.start);
        const first = slice[0]!;
        let off = 1;
        if (first === 0x58) off = 2;
        else if (first === 0x59) off = 3;
        else if ((first & 0xe0) !== 0x40) return null;
        return slice.subarray(off);
    } catch {
        return null;
    }
}

/** Script hash of a `[lang, script]` wrapper: blake2b_224(lang ‖ native CBOR or Plutus flat bytes). */
function scriptHashOfWrapped(wrapped: Uint8Array): string | null {
    try {
        const arr = Cbor.parse(wrapped);
        if (!(arr instanceof CborArray) || !(arr.array[0] instanceof CborUInt)) return null;
        const lang = Number((arr.array[0] as CborUInt).num);
        const body = arr.array[1];
        if (!body) return null;
        const scriptBytes = lang === 0 ? Cbor.encode(body) : body instanceof CborBytes ? body.bytes : null;
        if (!scriptBytes) return null;
        const pre = new Uint8Array(1 + scriptBytes.length);
        pre[0] = lang;
        pre.set(scriptBytes, 1);
        return toHex(blake2b_224(pre));
    } catch {
        return null;
    }
}

/** Babbage datum/reference-script fields straight from the output's CBOR bytes (same rules as Gerolamo). */
function txOutMetadata(o: any): Pick<LedgerOut, "datumHash" | "inlineDatum" | "scriptRefHash"> {
    let bytes: Uint8Array | null = null;
    try { bytes = o?.cborRef?.toBuffer?.() ?? o?.toCborBytes?.() ?? null; } catch { bytes = null; }
    let obj: CborObj | null = null;
    if (bytes) { try { obj = Cbor.parse(bytes); } catch { obj = null; } }
    if (obj instanceof CborArray) {
        const third = obj.array[2];
        if (third instanceof CborBytes && third.bytes.length === 32) return { datumHash: toHex(third.bytes) };
        return {};
    }
    if (!(obj instanceof CborMap)) {
        // duck-typed fallback for outputs built without CBOR
        const d: any = o?.datum;
        if (d != null) {
            const asHex = typeof d.toString === "function" ? String(d.toString()) : "";
            if (/^[0-9a-f]{64}$/i.test(asHex)) return { datumHash: asHex.toLowerCase() };
            try { return { inlineDatum: toHex(typeof d.toCbor === "function" ? d.toCbor().toBuffer() : d.cborRef?.toBuffer?.()) }; } catch { /* undefined */ }
        }
        const rs: any = o?.refScript;
        const h = rs?.hash?.toString?.();
        if (h && /^[0-9a-f]{56}$/i.test(h)) return { scriptRefHash: h.toLowerCase() };
        return {};
    }
    const out: Pick<LedgerOut, "datumHash" | "inlineDatum" | "scriptRefHash"> = {};
    for (const { k, v } of obj.map) {
        if (!(k instanceof CborUInt)) continue;
        const key = Number(k.num);
        if (key === 2 && v instanceof CborArray) {
            const kind = v.array[0], payload = v.array[1];
            if (kind instanceof CborUInt && Number(kind.num) === 0 && payload instanceof CborBytes) out.datumHash = toHex(payload.bytes);
            else if (kind instanceof CborUInt && Number(kind.num) === 1 && payload instanceof CborTag && payload.data instanceof CborBytes) out.inlineDatum = toHex(payload.data.bytes);
        } else if (key === 3 && v instanceof CborTag && v.data instanceof CborBytes) {
            out.scriptRefHash = scriptHashOfWrapped(v.data.bytes) ?? undefined;
        }
    }
    return out;
}
function stakeKeyOfRawAddress(raw: Uint8Array | null): string | null {
    if (!raw || raw.length !== 57) return null;
    const type = raw[0]! >> 4;
    if (type > 3) return null;
    let hex = "";
    for (let i = 29; i < 57; i++) hex += raw[i]!.toString(16).padStart(2, "0");
    return (type === 2 || type === 3 ? "01" : "") + hex;
}

/** The UTxO row an output becomes; same field rules as Gerolamo's server UTxO rows. */
export function outFromTxOut(txHash: string, index: number, o: any, slot: number): LedgerOut {
    const address = String(o.address.toString());
    const raw = rawAddressBytesOf(o.address);
    const value = o.value;
    const assets: LedgerAsset[] = [];
    for (const entry of (value?.map ?? [])) {
        const policy = String(entry.policy.toString()).toLowerCase();
        if (!policy) continue; // the value's lovelace entry has an empty policy; `lovelaces` already carries it
        for (const a of (entry.assets ?? [])) {
            assets.push({ policy, name: toHex(a.name), quantity: String(a.quantity) });
        }
    }
    return {
        ref: `${txHash}:${index}`,
        txHash,
        address,
        addressBytes: raw ? toHex(raw) : "",
        lovelace: String(value?.lovelaces?.toString?.() ?? value?.lovelaces ?? 0n),
        assets,
        ...txOutMetadata(o),
        ...(raw ? { stakeKey: stakeKeyOfRawAddress(raw) ?? undefined } : {}),
        createdSlot: slot,
        spentSlot: null,
    };
}

/** `txid:index` of inputs, each once (pre-Conway lists may repeat an input; the ledger spends the set). */
function inputRefs(inputs: any[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const i of inputs) {
        try {
            const id = String(i.utxoRef.id.toString()).toLowerCase();
            const index = Number(i.utxoRef.index);
            if (!/^[0-9a-f]{64}$/.test(id) || !Number.isFinite(index)) continue;
            const ref = `${id}:${index}`;
            if (!seen.has(ref)) { seen.add(ref); out.push(ref); }
        } catch { /* malformed input: the byte check accepted the block, rule checks are P2 */ }
    }
    return out;
}

/**
 * Parse a verified block's bytes into its UTxO diff. Byron blocks (no Shelley tx bodies) give an empty diff.
 * Throws when the block cannot be decoded, so a partial diff never lands.
 */
/** Fresh arrays: every block diff owns its counters, never a shared ZERO_P2 literal. */
function freshP2(): LedgerP2Diff {
    return { fees: "0", deposits: "0", withdrawals: "0", treasury: "0", donation: "0", minted: [], stakeRegistered: [], stakeUnregistered: [], stakeDelegations: [], poolRegistrations: [], poolRetirements: [], governanceDeposits: [] };
}
function bigStr(v: any): string { try { return BigInt(v?.toString?.() ?? v ?? 0n).toString(); } catch { return "0"; } }
function certKind(c: any): string { return String(c?.__typename ?? c?.type ?? c?.tag ?? "").toLowerCase(); }
function credentialOf(c: any): string {
    const x = c?.stakeCredential ?? c?.credential ?? c?.stakeCred;
    return x == null ? "" : String(x?.toString?.() ?? x).toLowerCase();
}
function poolOf(c: any): string { const x = c?.poolKeyHash ?? c?.poolId ?? c?.pool; return x == null ? "" : String(x.toString?.() ?? x).toLowerCase(); }
/** Ledger-ts fields are arrays, `null` for missing Conway `Maybe`s, or objects carrying their list under `map`/`entries`. */
function typeList(v: any): any[] {
    if (Array.isArray(v)) return v;
    for (const k of ["map", "entries", "items", "certificates", "procedures"]) { const x = v?.[k]; if (Array.isArray(x)) return x; }
    return [];
}
function p2DeltaOfBody(body: any, invalid: boolean): LedgerP2Diff {
    if (invalid) return { ...freshP2(), fees: bigStr(body.fee) };
    const p2: LedgerP2Diff = { ...freshP2(), fees: bigStr(body.fee) };
    for (const w of typeList(body.withdrawals) as any[]) p2.withdrawals = (BigInt(p2.withdrawals) + BigInt(bigStr(w.amount ?? w.reward ?? w))).toString();
    p2.treasury = bigStr(body.treasury ?? body.currentTreasuryValue ?? body.treasuryValue);
    p2.donation = bigStr(body.donation ?? body.donationValue);
    for (const c of typeList(body.certs ?? body.certificates)) {
        const kind = certKind(c), cred = credentialOf(c), pool = poolOf(c);
        if (kind.includes("stake") && (kind.includes("reg") || kind.includes("registration")) && !kind.includes("unreg")) {
            if (cred) p2.stakeRegistered.push(cred);
            p2.deposits = (BigInt(p2.deposits) + 2000000n).toString();
        } else if (kind.includes("unreg") || kind.includes("dereg")) {
            if (cred) p2.stakeUnregistered.push(cred);
        } else if (kind.includes("deleg")) {
            if (cred && pool) p2.stakeDelegations.push([cred, pool]);
        } else if (kind.includes("pool") && (kind.includes("reg") || kind.includes("registration"))) {
            if (pool) p2.poolRegistrations.push(pool);
            p2.deposits = (BigInt(p2.deposits) + 500000000n).toString();
        } else if (kind.includes("pool") && kind.includes("retire")) {
            if (pool) p2.poolRetirements.push(pool);
        }
    }
    for (const proposal of typeList(body.proposalProcedures ?? body.proposals) as any[]) {
        const deposit = proposal?.deposit ?? proposal?.depositAmount;
        if (deposit != null) p2.governanceDeposits.push(bigStr(deposit));
        else p2.governanceDeposits.push("0");
    }
    return p2;
}

function mergeP2(a: LedgerP2Diff, b: LedgerP2Diff): LedgerP2Diff {
    return { fees: (BigInt(a.fees)+BigInt(b.fees)).toString(), deposits: (BigInt(a.deposits)+BigInt(b.deposits)).toString(),
        withdrawals: (BigInt(a.withdrawals)+BigInt(b.withdrawals)).toString(), treasury: (BigInt(a.treasury)+BigInt(b.treasury)).toString(),
        donation: (BigInt(a.donation)+BigInt(b.donation)).toString(), minted: [...a.minted, ...b.minted],
        stakeRegistered: [...a.stakeRegistered, ...b.stakeRegistered], stakeUnregistered: [...a.stakeUnregistered, ...b.stakeUnregistered],
        stakeDelegations: [...a.stakeDelegations, ...b.stakeDelegations], poolRegistrations: [...a.poolRegistrations, ...b.poolRegistrations],
        poolRetirements: [...a.poolRetirements, ...b.poolRetirements], governanceDeposits: [...a.governanceDeposits, ...b.governanceDeposits] };
}

export function ledgerDiffFromBlock(bytes: Uint8Array, slot: number, hash: string): LedgerBlockDiff {
    const m = MultiEraBlock.fromCbor(bytes);
    const block: any = m.block;
    const bodies: any[] = Array.isArray(block?.transactionBodies) ? block.transactionBodies : [];
    const eraTag = Number(m.era ?? block?.era ?? 0);
    if (eraTag >= 8) return dijkstraLedgerDiff(block, bodies, slot, hash);
    if (bodies.length === 0) return { format: 1, slot, hash, txs: 0, invalidTx: [], created: [], spent: [], unknownInputs: [], p2: freshP2() };
    const invalid = new Set<number>(((block?.invalidTransactions ?? []) as Array<number | bigint>).map((i) => Number(i)));
    const diff: LedgerBlockDiff = { format: 1, slot, hash, txs: bodies.length, invalidTx: [...invalid], created: [], spent: [], unknownInputs: [], p2: freshP2() };
    const seenSpent = new Set<string>();
    bodies.forEach((body, txIndex) => {
        const txHash = String(body.hash.toString()).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(txHash)) return;
        if (diff.p2) diff.p2 = mergeP2(diff.p2, p2DeltaOfBody(body, invalid.has(txIndex)));
        if (invalid.has(txIndex)) {
            for (const ref of inputRefs(body.collateralInputs ?? [])) if (!seenSpent.has(ref)) { seenSpent.add(ref); diff.spent.push(ref); }
            if (body.collateralReturn) diff.created.push(outFromTxOut(txHash, (body.outputs ?? []).length, body.collateralReturn, slot));
            return;
        }
        for (const ref of inputRefs(body.inputs ?? [])) if (!seenSpent.has(ref)) { seenSpent.add(ref); diff.spent.push(ref); }
        (body.outputs ?? []).forEach((o: any, i: number) => diff.created.push(outFromTxOut(txHash, i, o, slot)));
    });
    return diff;
}

/** Blake2b-256 of a Dijkstra (sub-)transaction body's original bytes, as its transaction id. */
function dijkstraBodyHash(body: any): string {
    const h = String(body?.hash?.toString?.() ?? "").toLowerCase();
    if (/^[0-9a-f]{64}$/.test(h)) return h;
    const bytes = body?.cborRef?.toBuffer?.() ?? body?.toCborBytes?.() ?? null;
    if (!bytes) throw new Error("Dijkstra body bytes unavailable");
    return toHex(blake2b_256(bytes));
}

/** P2 deltas of one Dijkstra body, including its sub-transactions (which carry no fee). */
function dijkstraP2Delta(tx: any, valid: boolean): LedgerP2Diff {
    const body = tx?.body ?? tx;
    const p2 = p2DeltaOfBody(body, !valid);
    for (const sub of typeList(body?.subTransactions)) {
        const sb = sub?.body ?? sub;
        const d = p2DeltaOfBody(sb, false);
        p2.fees = (BigInt(p2.fees) + BigInt(d.fees)).toString();
        p2.deposits = (BigInt(p2.deposits) + BigInt(d.deposits)).toString();
        p2.withdrawals = (BigInt(p2.withdrawals) + BigInt(d.withdrawals)).toString();
        p2.treasury = (BigInt(p2.treasury) + BigInt(d.treasury)).toString();
        p2.donation = (BigInt(p2.donation) + BigInt(d.donation)).toString();
        p2.minted.push(...d.minted);
        p2.stakeRegistered.push(...d.stakeRegistered); p2.stakeUnregistered.push(...d.stakeUnregistered);
        p2.stakeDelegations.push(...d.stakeDelegations); p2.poolRegistrations.push(...d.poolRegistrations);
        p2.poolRetirements.push(...d.poolRetirements); p2.governanceDeposits.push(...d.governanceDeposits);
    }
    for (const b of [body, ...typeList(body?.subTransactions).map((s: any) => s?.body ?? s)]) {
        for (const w of typeList(b?.directDeposits)) p2.deposits = (BigInt(p2.deposits) + BigInt(bigStr(w?.amount ?? w))).toString();
    }
    return p2;
}

/** UTxO and P2 effects of a Dijkstra block: top-level transactions plus their sub-transactions. */
function dijkstraLedgerDiff(block: any, bodies: any[], slot: number, hash: string): LedgerBlockDiff {
    const txs = Array.isArray(block?.transactions) ? block.transactions as any[] : [];
    const diff: LedgerBlockDiff = { format: 1, slot, hash, txs: txs.length, invalidTx: [], created: [], spent: [], unknownInputs: [], p2: freshP2() };
    const seenSpent = new Set<string>();
    for (const [txIndex, tx] of txs.entries()) {
        const body = tx?.body ?? bodies[txIndex];
        if (!body) continue;
        const valid = tx?.isScriptValid !== false;
        if (!valid) diff.invalidTx.push(txIndex);
        diff.p2 = mergeP2(diff.p2 ?? freshP2(), dijkstraP2Delta(tx, valid));
        const topHash = dijkstraBodyHash(body);
        if (!valid) {
            for (const ref of inputRefs(body.collateralInputs ?? [])) if (!seenSpent.has(ref)) { seenSpent.add(ref); diff.spent.push(ref); }
            if (body.collateralReturn) diff.created.push(outFromTxOut(topHash, (body.outputs ?? []).length, body.collateralReturn, slot));
            continue;
        }
        for (const sub of typeList(body.subTransactions)) {
            const sb = sub?.body ?? sub;
            const subHash = dijkstraBodyHash(sb);
            for (const ref of inputRefs(sb.inputs ?? [])) if (!seenSpent.has(ref)) { seenSpent.add(ref); diff.spent.push(ref); }
            (sb.outputs ?? []).forEach((o: any, i: number) => diff.created.push(outFromTxOut(subHash, i, o, slot)));
        }
        for (const ref of inputRefs(body.inputs ?? [])) if (!seenSpent.has(ref)) { seenSpent.add(ref); diff.spent.push(ref); }
        (body.outputs ?? []).forEach((o: any, i: number) => diff.created.push(outFromTxOut(topHash, i, o, slot)));
    }
    return diff;
}
