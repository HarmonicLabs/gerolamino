/**
 * Local ledger snapshot (`snapshot.json`): the P1 base state under the per-block diff log.
 *
 * A snapshot is the UTxO projection at a slot, including spent tombstones so the query surface keeps the
 * same semantics after compaction. It also carries the chain digest at that slot, the original coverage
 * start and cumulative counters. Resume reads the snapshot once and then replays only the diffs newer than
 * its slot. An imported Mithril base has `historyComplete: false` because the ancillary `tables` hold the
 * UTxO set at the snapshot slot, not the spent history before it.
 */
import { blake2b_256 } from "@harmoniclabs/crypto";
import { toHex } from "@harmoniclabs/uint8array-utils";
import type { LedgerBlockDiff, LedgerOut } from "./ledgerApply";
import type { LedgerCoverage } from "./ledgerStore";

export const LEDGER_SNAPSHOT = "snapshot.json";
export const LEDGER_SNAPSHOT_FORMAT = 1;

export interface LedgerSnapshot {
    format: 1;
    network: string;
    /** Original coverage start; compaction never changes it. */
    startSlot: number | null;
    /** Coverage kind of the base state (`verified-start`, `snapshot`, `genesis`). */
    kind: LedgerCoverage["kind"];
    /** Slot at which this snapshot was taken. */
    slot: number;
    /** Chain digest at `slot`; the first replayed diff must continue from it. */
    digest: string;
    /** Integrity digest of `utxos`, independent of the chain digest. */
    stateDigest: string;
    /** Cumulative counters through `slot`. */
    blocks: number;
    created: number;
    spent: number;
    unknownInputs: number;
    invalidTx: number;
    /** True when spent tombstones are present; false for UTxO-only Mithril imports. */
    historyComplete: boolean;
    utxos: LedgerOut[];
    at: number;
}

/** Stable digest of the snapshot's UTxO rows, sorted by ref. Used to reject a corrupt/edited base.
 *  Rows are hashed in bounded batches so a multi-million-row snapshot never needs one giant JSON string. */
export function snapshotStateDigest(utxos: LedgerOut[]): string {
    const sorted = [...utxos];
    sorted.sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    let partBytes = 0;
    let acc: Uint8Array | null = null;
    const flush = () => {
        if (!parts.length) return;
        const batch = new Uint8Array(partBytes);
        let off = 0;
        for (const p of parts) { batch.set(p, off); off += p.length; }
        const prev = acc;
        const data = prev ? new Uint8Array(prev.length + batch.length) : batch;
        if (prev) { data.set(prev, 0); data.set(batch, prev.length); }
        acc = blake2b_256(data);
        parts.length = 0; partBytes = 0;
    };
    for (const o of sorted) {
        const row = enc.encode(JSON.stringify({
            ref: o.ref,
            txHash: o.txHash,
            address: o.address,
            addressBytes: o.addressBytes,
            lovelace: o.lovelace,
            assets: o.assets,
            datumHash: o.datumHash ?? null,
            inlineDatum: o.inlineDatum ?? null,
            scriptRefHash: o.scriptRefHash ?? null,
            stakeKey: o.stakeKey ?? null,
            createdSlot: o.createdSlot,
            spentSlot: o.spentSlot,
        }));
        parts.push(row); partBytes += row.length;
        if (partBytes >= 4 * 1024 * 1024) flush();
    }
    flush();
    return toHex(acc ?? blake2b_256(new Uint8Array(0)));
}

/** Validate the structural parts of a parsed snapshot without trusting its digest fields. */
export function snapshotLooksValid(s: unknown, network: string): s is LedgerSnapshot {
    if (!s || typeof s !== "object") return false;
    const v = s as Partial<LedgerSnapshot>;
    if (v.format !== LEDGER_SNAPSHOT_FORMAT || v.network !== network) return false;
    if (!Number.isInteger(v.slot) || v.slot! < 0) return false;
    if (!(v.startSlot === null || (Number.isInteger(v.startSlot) && v.startSlot! >= 0))) return false;
    if (v.kind !== "verified-start" && v.kind !== "snapshot" && v.kind !== "genesis") return false;
    if (typeof v.digest !== "string" || !/^[0-9a-f]{64}$/i.test(v.digest)) return false;
    if (typeof v.stateDigest !== "string" || !/^[0-9a-f]{64}$/i.test(v.stateDigest)) return false;
    if (!Array.isArray(v.utxos)) return false;
    return typeof v.historyComplete === "boolean";
}

/** Cumulative counters from a set of stored diffs. */
export function diffCounters(diffs: Iterable<LedgerBlockDiff>): Pick<LedgerSnapshot, "blocks" | "created" | "spent" | "unknownInputs" | "invalidTx"> {
    let blocks = 0, created = 0, spent = 0, unknownInputs = 0, invalidTx = 0;
    for (const d of diffs) {
        blocks += 1;
        created += d.created.length;
        spent += d.spent.length;
        unknownInputs += d.unknownInputs.length;
        invalidTx += d.invalidTx.length;
    }
    return { blocks, created, spent, unknownInputs, invalidTx };
}
