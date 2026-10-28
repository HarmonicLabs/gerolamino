/**
 * Volatile store: verified blocks near the tip live here (one small OPFS file per block) instead of in
 * the cardano-node immutable chunk files. A block becomes immutable only when it is k slots behind the
 * tip (`promoteOlderThan`), and a rollback inside the k window therefore only truncates this store:
 * the chunk files are never rewritten for a tip that could still be rolled back.
 *
 * Files: `v-<10-digit slot>.blk`, content = header hash (32 bytes) + block bytes (`[era, block]`).
 * Resume reads them in slot order; a file shorter than hash + 1 byte is skipped (a torn write).
 */
import type { FileSink } from "./chunkWriter";

export interface VolatileBlock { slot: number; hash: Uint8Array; bytes: Uint8Array }
export interface VolatileTip { slot: number; hash: Uint8Array }

const FILE_RE = /^v-(\d{10})\.blk$/;
const fileName = (slot: number) => `v-${String(slot).padStart(10, "0")}.blk`;

export class VolatileStore {
    private entries: VolatileBlock[] = [];

    constructor(private readonly sink: FileSink) {}

    get stats(): { blocks: number; bytes: number } {
        let bytes = 0;
        for (const e of this.entries) bytes += e.bytes.length;
        return { blocks: this.entries.length, bytes };
    }

    /** The newest stored block, or null when the store is empty. */
    get tip(): VolatileTip | null {
        const e = this.entries[this.entries.length - 1];
        return e ? { slot: e.slot, hash: e.hash.slice() } : null;
    }

    /** Reload from the sink (slot order). Returns the stored tip, or null for an empty store. */
    async resume(): Promise<VolatileTip | null> {
        const slots = (await this.sink.list())
            .map((n) => FILE_RE.exec(n))
            .filter((m): m is RegExpExecArray => !!m)
            .map((m) => Number(m[1]))
            .sort((a, b) => a - b);
        this.entries = [];
        for (const slot of slots) {
            const bytes = await this.sink.read(fileName(slot));
            if (!bytes || bytes.length < 33) continue;
            this.entries.push({ slot, hash: bytes.slice(0, 32), bytes: bytes.slice(32) });
        }
        return this.tip;
    }

    /** Append a verified block; slots must increase. */
    async append(slot: number, hash: Uint8Array, bytes: Uint8Array): Promise<void> {
        const last = this.entries[this.entries.length - 1];
        if (last && slot <= last.slot) throw new Error(`volatile append: slot ${slot} is not after the stored tip ${last.slot} (roll back first)`);
        if (hash.length !== 32) throw new Error(`volatile append: header hash is ${hash.length} bytes, expected 32`);
        const out = new Uint8Array(32 + bytes.length);
        out.set(hash, 0);
        out.set(bytes, 32);
        await this.sink.write(fileName(slot), out);
        this.entries.push({ slot, hash: hash.slice(), bytes });
    }

    /** Drop every block with a slot after `slot` (RollBackward inside the k window). Returns blocks removed. */
    async rollbackTo(slot: number): Promise<number> {
        let removed = 0;
        while (this.entries.length && this.entries[this.entries.length - 1]!.slot > slot) {
            const e = this.entries.pop()!;
            await this.sink.remove?.(fileName(e.slot));
            removed++;
        }
        return removed;
    }

    /**
     * Take every block with a slot at or below `cutoffSlot` (oldest first), remove it from this store and
     * return it for the immutable chunk writer. A block at or below the cutoff can no longer be rolled back
     * (the chain-sync peer may roll back at most k blocks, each in its own slot).
     */
    async promoteOlderThan(cutoffSlot: number): Promise<VolatileBlock[]> {
        let n = 0;
        while (n < this.entries.length && this.entries[n]!.slot <= cutoffSlot) n++;
        if (!n) return [];
        const out = this.entries.slice(0, n);
        this.entries = this.entries.slice(n);
        for (const e of out) await this.sink.remove?.(fileName(e.slot));
        return out;
    }

    /** Remove every file and entry (used with the store wipe). */
    async wipe(): Promise<void> {
        for (const e of this.entries) await this.sink.remove?.(fileName(e.slot));
        this.entries = [];
        for (const name of await this.sink.list()) if (FILE_RE.test(name)) await this.sink.remove?.(name);
    }
}
