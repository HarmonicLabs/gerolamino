/**
 * UTxO projection for Gerolamino's local ledger (docs/LEDGER_SPEC.md P0): what a verified block does to the
 * UTxO set, read from the block's own bytes with cardano-ledger-ts. Phase-2 invalid transactions spend only
 * their collateral and create only a collateral return; ordinary transactions spend their inputs and create
 * their outputs. Reference inputs are not spent by ordinary inputs. Script execution, fees, stake and
 * governance effects stay out (P2); this is a light-node projection, not consensus validation.
 */
import { Cbor, CborArray, CborBytes, CborMap, CborObj, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { blake2b_224 } from "@harmoniclabs/crypto";
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
        const scriptBytes = lang === 0 ? Cbor.encode(body).toBuffer() : body instanceof CborBytes ? body.bytes : null;
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
export function ledgerDiffFromBlock(bytes: Uint8Array, slot: number, hash: string): LedgerBlockDiff {
    const m = MultiEraBlock.fromCbor(bytes);
    const block: any = m.block;
    const bodies: any[] = Array.isArray(block?.transactionBodies) ? block.transactionBodies : [];
    if (bodies.length === 0) return { format: 1, slot, hash, txs: 0, invalidTx: [], created: [], spent: [], unknownInputs: [] };
    const invalid = new Set<number>(((block?.invalidTransactions ?? []) as Array<number | bigint>).map((i) => Number(i)));
    const diff: LedgerBlockDiff = { format: 1, slot, hash, txs: bodies.length, invalidTx: [...invalid], created: [], spent: [], unknownInputs: [] };
    const seenSpent = new Set<string>();
    bodies.forEach((body, txIndex) => {
        const txHash = String(body.hash.toString()).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(txHash)) return;
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
