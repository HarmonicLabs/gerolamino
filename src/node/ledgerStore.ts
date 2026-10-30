/**
 * The browser-side UTxO set and its per-block diff log (docs/LEDGER_SPEC.md P0). State lives in memory,
 * durability lives in OPFS: one `b-<slot>-<hash>.ldiff` file per verified block plus a manifest written last.
 * A resume replays the diffs, a rollback reverses them and deletes their files. All keys are UTxO refs
 * (`txid:index`); spent outputs stay as tombstones until compaction so a rollback can restore them.
 *
 * This is a light-node projection: it never claims consensus validation, script execution or genesis coverage
 * unless the manifest says so. A bad diff fails the ledger, never the verified chain store.
 */
import { blake2b_256 } from "@harmoniclabs/crypto";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import type { FileSink } from "./chunkWriter";
import type { LedgerBlockDiff, LedgerOut } from "./ledgerApply";
import { LEDGER_SNAPSHOT, snapshotLooksValid, snapshotStateDigest, diffCounters, type LedgerSnapshot } from "./ledgerSnapshot";

export interface LedgerCoverage {
    network: string;
    /** First slot the UTxO set covers; null when nothing has been applied. */
    startSlot: number | null;
    /** `verified-start` for P0; `snapshot`/`genesis` when a snapshot bootstrap lands (P1). */
    kind: "verified-start" | "snapshot" | "genesis";
    tipSlot: number | null;
    blocks: number;
    utxoCount: number;
    digest: string | null;
    stale: boolean;
}

export interface LedgerStats extends LedgerCoverage {
    created: number;
    spent: number;
    unknownInputs: number;
    invalidTx: number;
    lastError: string | null;
}

interface LedgerManifest {
    format: 1;
    network: string;
    startSlot: number | null;
    kind: LedgerCoverage["kind"];
    tipSlot: number | null;
    blocks: number;
    utxoCount: number;
    created: number;
    spent: number;
    unknownInputs: number;
    invalidTx: number;
    digest: string | null;
    stale: boolean;
    at: number;
    /** P1 base snapshot this ledger resumed from / compacted to. */
    baseSlot?: number | null;
    baseDigest?: string | null;
    baseBlocks?: number;
    baseCreated?: number;
    baseSpent?: number;
    baseUnknownInputs?: number;
    baseInvalidTx?: number;
    historyComplete?: boolean;
}

interface StoredDiff extends LedgerBlockDiff {
    prevDigest: string | null;
    digest: string;
    unknownInputs: string[];
}

export const LEDGER_MANIFEST = "manifest.json";
export const LEDGER_FORMAT = 1;
const DIFF_PREFIX = "b-";
const DIFF_RE = /^b-(\d{10})-([0-9a-f]{8})\.ldiff$/;

export function ledgerDiffName(slot: number, hash: string): string {
    return `${DIFF_PREFIX}${String(slot).padStart(10, "0")}-${hash.slice(0, 8)}.ldiff`;
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out;
};

export class LocalLedger {
    private readonly utxos = new Map<string, LedgerOut>();
    private readonly byAddress = new Map<string, Set<string>>();
    private readonly byTx = new Map<string, { out: string[]; input: string[] }>();
    private readonly stakeBalance = new Map<string, bigint>();
    private readonly diffs = new Map<number, StoredDiff>();
    private manifest: LedgerManifest | null = null;
    private snapshot: LedgerSnapshot | null = null;
    private digest: string | null = null;
    private lastError: string | null = null;

    constructor(private readonly sink: FileSink | null | undefined, readonly network: string) {}

    get coverage(): LedgerCoverage {
        let unspent = 0;
        for (const u of this.utxos.values()) if (u.spentSlot == null) unspent++;
        return {
            network: this.network,
            startSlot: this.manifest?.startSlot ?? null,
            kind: this.manifest?.kind ?? "verified-start",
            tipSlot: this.manifest?.tipSlot ?? null,
            blocks: this.manifest?.blocks ?? 0,
            utxoCount: unspent,
            digest: this.digest,
            stale: this.manifest?.stale ?? false,
        };
    }

    get stats(): LedgerStats {
        let invalid = this.manifest?.baseInvalidTx ?? 0;
        for (const d of this.diffs.values()) invalid += d.invalidTx.length;
        return {
            ...this.coverage,
            created: this.manifest?.created ?? 0,
            spent: this.manifest?.spent ?? 0,
            unknownInputs: this.manifest?.unknownInputs ?? 0,
            invalidTx: invalid,
            lastError: this.lastError,
        };
    }

    /** True when the base holds spent tombstones as well as unspent UTxO (P0/local compaction); false for an
     * imported UTxO-only Mithril snapshot. */
    get historyComplete(): boolean { return this.manifest?.historyComplete ?? this.snapshot?.historyComplete ?? true; }

    /** Read the manifest and replay the diff log; throws only when a stored diff is unreadable in a way that
     * makes a partial state unsafe. A missing diff or a digest chain break marks the ledger stale but loads the
     * diffs it can. */
    async resume(): Promise<LedgerStats> {
        this.clear();
        const names = (await this.sink?.list?.()) ?? [];
        const files = names.map((n) => {
            const m = DIFF_RE.exec(n);
            return m ? { name: n, slot: Number(m[1]), hash: m[2]! } : null;
        }).filter((x): x is { name: string; slot: number; hash: string } => !!x).sort((a, b) => a.slot - b.slot);
        const manifestBytes = await this.sink?.read?.(LEDGER_MANIFEST) ?? null;
        let corruptManifest = false;
        if (manifestBytes) {
            try {
                const parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as LedgerManifest;
                this.manifest = parsed?.format === LEDGER_FORMAT ? parsed : null;
                if (!this.manifest) corruptManifest = true;
            } catch { this.manifest = null; corruptManifest = true; }
        } else {
            this.manifest = null;
        }
        let stale = corruptManifest || (!manifestBytes && files.length > 0) || (this.manifest?.stale ?? false);
        const snapshotBytes = await this.sink?.read?.(LEDGER_SNAPSHOT) ?? null;
        if (snapshotBytes) {
            try {
                const parsed = JSON.parse(new TextDecoder().decode(snapshotBytes));
                if (!snapshotLooksValid(parsed, this.network)) {
                    stale = true;
                } else {
                    this.snapshot = parsed;
                    if (this.snapshot.stateDigest !== snapshotStateDigest(this.snapshot.utxos)) stale = true;
                    if (this.manifest) {
                        if (this.manifest.baseSlot !== this.snapshot.slot || this.manifest.startSlot !== this.snapshot.startSlot || this.manifest.kind !== this.snapshot.kind) stale = true;
                        if (this.manifest.baseDigest != null && this.manifest.baseDigest !== this.snapshot.digest) stale = true;
                    }
                    this.restoreSnapshot(this.snapshot);
                }
            } catch { stale = true; }
        } else if (this.manifest?.baseSlot != null) {
            stale = true;
        }
        let prev: string | null = this.snapshot?.digest ?? null;
        const activeFiles = files.filter((f) => !this.snapshot || f.slot > this.snapshot.slot);
        for (const f of activeFiles) {
            const bytes = await this.sink!.read(f.name);
            if (!bytes) { stale = true; continue; }
            let d: StoredDiff;
            try { d = JSON.parse(new TextDecoder().decode(bytes)) as StoredDiff; } catch { stale = true; break; }
            if (d.format !== LEDGER_FORMAT || d.slot !== f.slot) { stale = true; break; }
            if ((d.prevDigest ?? null) !== prev) stale = true;
            const existing = this.diffs.get(d.slot);
            if (existing) { this.reverseDiff(existing); this.diffs.delete(d.slot); stale = true; }
            this.applyDiff(d);
            this.diffs.set(d.slot, d);
            prev = d.digest;
        }
        this.digest = prev;
        const tip = activeFiles[activeFiles.length - 1]?.slot ?? this.snapshot?.slot ?? null;
        if (this.manifest && this.manifest.tipSlot != null && tip !== this.manifest.tipSlot) stale = true;
        if (this.manifest && this.manifest.digest !== prev) stale = true;
        if (this.manifest?.baseSlot != null && this.manifest.baseSlot !== this.snapshot?.slot) stale = true;
        this.syncManifest(stale);
        return this.stats;
    }

    /**
     * Apply one verified block's UTxO diff: create outputs, spend inputs (unknown refs are recorded, not fatal),
     * persist the diff then the manifest. Throws when the sink write fails (the caller keeps the chain store).
     */
    async apply(blockBytes: Uint8Array, slot: number, hash: string, parsed: LedgerBlockDiff): Promise<void> {
        if (!Number.isFinite(slot) || !/^[0-9a-f]{64}$/i.test(hash)) throw new Error("bad ledger block header");
        if (parsed.format !== LEDGER_FORMAT || parsed.slot !== slot) throw new Error("ledger diff does not match its block");
        hash = hash.toLowerCase();
        const existing = this.diffs.get(slot);
        if (existing && existing.hash === hash) return; // idempotent re-apply
        if (this.snapshot && slot <= this.snapshot.slot && !existing) throw new Error(`ledger: block ${slot} is below the snapshot base ${this.snapshot.slot}`);
        const oldDiffName = existing ? ledgerDiffName(slot, existing.hash) : null;
        if (existing) {
            // same slot on a new branch (rollback that kept the slot): undo the old diff first
            this.reverseDiff(existing);
            this.diffs.delete(slot);
            this.digest = existing.prevDigest;
        }
        const unknown = this.applyDiff(parsed, true);
        const digest = this.nextDigest(this.digest, parsed, unknown);
        const d: StoredDiff = { ...parsed, prevDigest: this.digest, digest, unknownInputs: unknown };
        this.diffs.set(slot, d);
        this.digest = digest;
        this.syncManifest();
        if (!this.sink) return;
        try {
            await this.sink.write(ledgerDiffName(slot, hash), new TextEncoder().encode(JSON.stringify(d)));
            await this.sink.write(LEDGER_MANIFEST, new TextEncoder().encode(JSON.stringify(this.manifest)));
            if (oldDiffName && oldDiffName !== ledgerDiffName(slot, hash)) await this.sink.remove?.(oldDiffName);
        } catch (e) {
            this.reverseDiff(d);
            this.diffs.delete(slot);
            this.digest = d.prevDigest;
            this.syncManifest();
            await this.sink.remove?.(ledgerDiffName(slot, hash));
            this.lastError = `ledger write failed at slot ${slot}: ${(e as Error).message}`;
            throw e;
        }
    }

    /**
     * Install a verified snapshot base: UTxO rows at `snapshot.slot`, with its digest and counters. Used by
     * the P1 Mithril `tables` import; local compaction goes through `compactTo` so it can keep the original
     * coverage start and tombstones.
     */
    async installSnapshot(snapshot: LedgerSnapshot, opts: { verifyStateDigest?: boolean } = {}): Promise<void> {
        if (!snapshotLooksValid(snapshot, this.network)) throw new Error("ledger: invalid snapshot");
        if (opts.verifyStateDigest !== false && snapshot.stateDigest !== snapshotStateDigest(snapshot.utxos)) throw new Error("ledger: snapshot state digest mismatch");
        this.clear();
        this.snapshot = snapshot;
        this.restoreSnapshot(snapshot);
        this.digest = snapshot.digest;
        this.syncManifest();
        if (!this.sink) return;
        await this.sink.write(LEDGER_SNAPSHOT, new TextEncoder().encode(JSON.stringify(snapshot)));
        await this.sink.write(LEDGER_MANIFEST, new TextEncoder().encode(JSON.stringify(this.manifest)));
    }

    /**
     * P1 local compaction: write a base snapshot at `slot`, keep only diffs newer than it, and drop the older
     * diff files. The snapshot keeps the original coverage start and every spent tombstone, so `/txs/...`
     * remains complete. A rollback below the snapshot slot marks the ledger stale; a deeper rebuild is P1 work.
     */
    async compactTo(slot: number): Promise<number> {
        if (!Number.isInteger(slot) || slot < 0) throw new Error("ledger: bad compaction slot");
        const sorted = [...this.diffs.values()].sort((a, b) => a.slot - b.slot);
        if (!sorted.length) return 0;
        const tip = sorted[sorted.length - 1]!.slot;
        const baseSlot = this.snapshot?.slot ?? null;
        const lowest = baseSlot ?? sorted[0]!.slot;
        if (slot < lowest) throw new Error(`ledger: compaction slot ${slot} is below the base ${lowest}`);
        if (slot > tip) throw new Error(`ledger: compaction slot ${slot} is above the tip ${tip}`);
        const newer = sorted.filter((d) => d.slot > slot);
        const older = sorted.filter((d) => d.slot <= slot);
        for (const d of [...newer].sort((a, b) => b.slot - a.slot)) this.reverseDiff(d);
        const oldBase = this.snapshot;
        const startSlot = oldBase?.startSlot ?? this.manifest?.startSlot ?? sorted[0]!.slot;
        const kind = oldBase?.kind ?? this.manifest?.kind ?? "verified-start";
        const counts = diffCounters(older);
        const digestAt = older.length ? older[older.length - 1]!.digest : oldBase?.digest;
        if (!digestAt) throw new Error("ledger: cannot compact without a digest");
        const utxos = [...this.utxos.values()].sort((a, b) => a.ref.localeCompare(b.ref));
        const snapshot: LedgerSnapshot = {
            format: 1,
            network: this.network,
            startSlot,
            kind,
            slot,
            digest: digestAt,
            stateDigest: snapshotStateDigest(utxos),
            blocks: (oldBase?.blocks ?? 0) + counts.blocks,
            created: (oldBase?.created ?? 0) + counts.created,
            spent: (oldBase?.spent ?? 0) + counts.spent,
            unknownInputs: (oldBase?.unknownInputs ?? 0) + counts.unknownInputs,
            invalidTx: (oldBase?.invalidTx ?? 0) + counts.invalidTx,
            historyComplete: oldBase?.historyComplete ?? true,
            utxos,
            at: Date.now(),
        };
        this.snapshot = snapshot;
        this.diffs.clear();
        for (const d of newer) this.diffs.set(d.slot, d);
        this.digest = digestAt;
        for (const d of [...newer].sort((a, b) => a.slot - b.slot)) {
            this.applyDiff(d);
            this.digest = d.digest;
        }
        this.syncManifest();
        if (!this.sink) return older.length;
        await this.sink.write(LEDGER_SNAPSHOT, new TextEncoder().encode(JSON.stringify(snapshot)));
        await this.sink.write(LEDGER_MANIFEST, new TextEncoder().encode(JSON.stringify(this.manifest)));
        for (const d of older) await this.sink.remove?.(ledgerDiffName(d.slot, d.hash));
        return older.length;
    }

    /** Reverse every diff newer than `slot`, delete their files and write the manifest. Returns blocks undone. */
    async rollbackTo(slot: number): Promise<number> {
        const undone = [...this.diffs.values()].filter((d) => d.slot > slot).sort((a, b) => b.slot - a.slot);
        if (!undone.length) {
            if (this.snapshot && slot < this.snapshot.slot) {
                this.lastError = `ledger rolled back below snapshot slot ${this.snapshot.slot} to ${slot}`;
                this.syncManifest(true);
                if (this.sink) await this.sink.write(LEDGER_MANIFEST, new TextEncoder().encode(JSON.stringify(this.manifest)));
            }
            return 0;
        }
        for (const d of undone) {
            this.reverseDiff(d);
            this.diffs.delete(d.slot);
        }
        this.digest = undone[undone.length - 1]!.prevDigest;
        if (this.snapshot && slot < this.snapshot.slot) this.lastError = `ledger rolled back below snapshot slot ${this.snapshot.slot} to ${slot}`;
        if (this.sink) {
            for (const d of undone) await this.sink.remove?.(ledgerDiffName(d.slot, d.hash));
            this.syncManifest(!!this.snapshot && slot < this.snapshot.slot);
            await this.sink.write(LEDGER_MANIFEST, new TextEncoder().encode(JSON.stringify(this.manifest)));
        } else if (this.snapshot && slot < this.snapshot.slot) {
            this.syncManifest(true);
        }
        return undone.length;
    }

    /** Mark the ledger stale after a decode or write gap; the chain store stays intact and local answers stop. */
    async markStale(message: string): Promise<void> {
        this.lastError = message;
        this.syncManifest(true);
        if (!this.sink) return;
        try { await this.sink.write(LEDGER_MANIFEST, new TextEncoder().encode(JSON.stringify(this.manifest))); }
        catch (e) { this.lastError = `ledger manifest write failed: ${(e as Error).message}`; }
    }

    /** Unspent UTxO by ref (the extension's /utxo/{txhash:index} shape), or null when spent/unknown. */
    utxo(ref: string): LedgerOut | null {
        const u = this.utxos.get(ref);
        return u && u.spentSlot == null ? u : null;
    }

    /** Every output the local ledger knows for a transaction (spent ones with `spent_boolean`). */
    txOutputs(txHash: string): LedgerOut[] {
        const t = this.byTx.get(txHash.toLowerCase());
        if (!t) return [];
        return t.out.map((r) => this.utxos.get(r)).filter((u): u is LedgerOut => !!u);
    }

    /** Unspent outputs at a Shelley address; complete only for coverage 0/snapshot. */
    addressUtxos(address: string): LedgerOut[] {
        const refs = this.byAddress.get(address);
        if (!refs) return [];
        return [...refs].map((r) => this.utxos.get(r)).filter((u): u is LedgerOut => !!u && u.spentSlot == null);
    }

    private clear(): void {
        this.utxos.clear(); this.byAddress.clear(); this.byTx.clear(); this.stakeBalance.clear(); this.diffs.clear();
        this.snapshot = null;
        this.digest = null; this.lastError = null;
    }

    /** Install the UTxO state of a snapshot base (tombstones included when the snapshot carries them). */
    private restoreSnapshot(s: LedgerSnapshot): void {
        for (const u of s.utxos) {
            this.utxos.set(u.ref, u);
            let set = this.byAddress.get(u.address);
            if (!set) this.byAddress.set(u.address, set = new Set());
            set.add(u.ref);
            let t = this.byTx.get(u.txHash);
            if (!t) this.byTx.set(u.txHash, t = { out: [], input: [] });
            if (!t.out.includes(u.ref)) t.out.push(u.ref);
            if (u.spentSlot == null && u.stakeKey) this.stakeBalance.set(u.stakeKey, (this.stakeBalance.get(u.stakeKey) ?? 0n) + BigInt(u.lovelace));
        }
    }

    private applyDiff(d: LedgerBlockDiff, recordUnknown = false): string[] {
        const unknown: string[] = [];
        // outputs first, so a same-block spend sees the output it spends
        for (const u of d.created) {
            this.utxos.set(u.ref, u);
            let set = this.byAddress.get(u.address);
            if (!set) this.byAddress.set(u.address, set = new Set());
            set.add(u.ref);
            if (u.stakeKey) this.stakeBalance.set(u.stakeKey, (this.stakeBalance.get(u.stakeKey) ?? 0n) + BigInt(u.lovelace));
            let t = this.byTx.get(u.txHash);
            if (!t) this.byTx.set(u.txHash, t = { out: [], input: [] });
            if (!t.out.includes(u.ref)) t.out.push(u.ref);
        }
        for (const ref of d.spent) {
            const u = this.utxos.get(ref);
            if (!u) { unknown.push(ref); continue; }
            if (u.spentSlot != null) continue; // duplicate spend in the same block: the set is spent once
            u.spentSlot = d.slot;
            if (u.stakeKey) this.stakeBalance.set(u.stakeKey, (this.stakeBalance.get(u.stakeKey) ?? 0n) - BigInt(u.lovelace));
            let t = this.byTx.get(u.txHash);
            if (!t) this.byTx.set(u.txHash, t = { out: [], input: [] });
            if (!t.input.includes(ref)) t.input.push(ref);
        }
        if (recordUnknown) d.unknownInputs = unknown;
        return unknown;
    }

    private reverseDiff(d: LedgerBlockDiff): void {
        for (const ref of d.spent) {
            const u = this.utxos.get(ref);
            if (!u || u.spentSlot !== d.slot) continue;
            u.spentSlot = null;
            if (u.stakeKey) this.stakeBalance.set(u.stakeKey, (this.stakeBalance.get(u.stakeKey) ?? 0n) + BigInt(u.lovelace));
            const t = this.byTx.get(u.txHash);
            if (t) { const i = t.input.indexOf(ref); if (i >= 0) t.input.splice(i, 1); }
        }
        for (const o of d.created) {
            const u = this.utxos.get(o.ref);
            if (!u) continue;
            this.utxos.delete(o.ref);
            const set = this.byAddress.get(u.address);
            if (set) { set.delete(o.ref); if (!set.size) this.byAddress.delete(u.address); }
            if (u.stakeKey) this.stakeBalance.set(u.stakeKey, (this.stakeBalance.get(u.stakeKey) ?? 0n) - BigInt(u.lovelace));
            const t = this.byTx.get(o.txHash);
            if (t) { const i = t.out.indexOf(o.ref); if (i >= 0) t.out.splice(i, 1); if (!t.out.length && !t.input.length) this.byTx.delete(o.txHash); }
        }
    }

    private nextDigest(prev: string | null, d: LedgerBlockDiff, unknown: string[]): string {
        const payload = new TextEncoder().encode(JSON.stringify({
            slot: d.slot, hash: d.hash, created: d.created.map((o) => o.ref), spent: d.spent, unknown, invalid: d.invalidTx,
        }));
        return toHex(blake2b_256(concat(prev ? fromHex(prev) : new Uint8Array(0), payload)));
    }

    private syncManifest(stale = this.manifest?.stale ?? false): void {
        const loaded = [...this.diffs.values()].sort((a, b) => a.slot - b.slot);
        const snap = this.snapshot;
        const tip = loaded[loaded.length - 1] ?? null;
        const start = snap?.startSlot ?? loaded[0]?.slot ?? this.manifest?.startSlot ?? null;
        const kind = snap?.kind ?? this.manifest?.kind ?? "verified-start";
        const baseBlocks = snap?.blocks ?? 0;
        const baseCreated = snap?.created ?? 0;
        const baseSpent = snap?.spent ?? 0;
        const baseUnknown = snap?.unknownInputs ?? 0;
        const baseInvalid = snap?.invalidTx ?? 0;
        const baseSlot = snap?.slot ?? null;
        const tipSlot = tip?.slot ?? baseSlot;
        const digest = this.digest;
        const utxoCount = [...this.utxos.values()].filter((u) => u.spentSlot == null).length;
        this.manifest = {
            format: LEDGER_FORMAT, network: this.network, startSlot: start, kind,
            tipSlot, blocks: baseBlocks + loaded.length, utxoCount,
            created: baseCreated + loaded.reduce((a, d) => a + d.created.length, 0),
            spent: baseSpent + loaded.reduce((a, d) => a + d.spent.length, 0),
            unknownInputs: baseUnknown + loaded.reduce((a, d) => a + d.unknownInputs.length, 0),
            invalidTx: baseInvalid + loaded.reduce((a, d) => a + d.invalidTx.length, 0),
            digest, stale, at: Date.now(),
        };
        if (snap) {
            this.manifest.baseSlot = snap.slot;
            this.manifest.baseDigest = snap.digest;
            this.manifest.baseBlocks = snap.blocks;
            this.manifest.baseCreated = snap.created;
            this.manifest.baseSpent = snap.spent;
            this.manifest.baseUnknownInputs = snap.unknownInputs;
            this.manifest.baseInvalidTx = snap.invalidTx;
            this.manifest.historyComplete = snap.historyComplete;
        }
    }

    /** Coverage statement for an answer: P0 has no genesis/snapshot completeness yet. */
    answerCoverage(): { startSlot: number | null; kind: LedgerCoverage["kind"]; tipSlot: number | null } {
        return { startSlot: this.manifest?.startSlot ?? null, kind: this.manifest?.kind ?? "verified-start", tipSlot: this.manifest?.tipSlot ?? null };
    }
}
