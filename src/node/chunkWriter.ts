/**
 * Chunk writer: verified blocks go into cardano-node-format chunk files (`NNNNN.chunk|primary|secondary`,
 * see chunkFormat.ts) through a `FileSink` (OPFS in the extension, memory in tests and the Bun smoke run).
 *
 * A light client syncing from the tip starts mid-chunk: the primary index is filled with repeated 0
 * offsets up to the first stored slot, which is a valid index for a chunk whose earlier slots are empty.
 * The open chunk is kept in memory and its three files rewritten on every append (≤ 1 MB each on
 * preview/preprod); a finished chunk is padded to its full primary length and written once.
 *
 * Rollbacks: the chain-sync peer may roll back up to k blocks. `rollbackTo(slot)` drops every stored
 * block after `slot` (truncating the open chunk, and removing later chunk files if a rollback ever
 * crosses a chunk boundary), so the files only ever hold the chain the node currently follows.
 */
import {
    SECONDARY_ENTRY_SIZE,
    chunkFileName,
    chunkNoOf,
    crc32,
    decodeSecondaryEntry,
    encodePrimary,
    encodeSecondaryEntry,
    locateHeader,
    primaryOffsetCount,
    relativeSlot,
} from "./chunkFormat";

export interface FileSink {
    write(name: string, bytes: Uint8Array): Promise<void>;
    read(name: string): Promise<Uint8Array | null>;
    list(): Promise<string[]>;
    remove?(name: string): Promise<void>;
}

interface OpenChunk {
    chunkNo: number;
    /** Primary offsets written so far (relative slot 0 … last filled slot + 1). */
    offsets: number[];
    /** Encoded secondary entries, one per block. */
    entries: Uint8Array[];
    blocks: Uint8Array[];
    slots: number[];
    bytes: number;
}

export interface StoredTip { slot: number; hash: Uint8Array; chunkNo: number }

const CHUNK_RE = /^(\d{5})\.chunk$/;

export class ChunkWriter {
    private open: OpenChunk | null = null;
    private stored = 0;
    private storedBytes = 0;
    private chunksDone = 0;
    private tipHash: Uint8Array | null = null;

    constructor(private readonly sink: FileSink, readonly chunkSlots: number) {}

    get stats() { return { blocks: this.stored, bytes: this.storedBytes, chunks: this.chunksDone + (this.open ? 1 : 0), openChunk: this.open?.chunkNo ?? null }; }

    /** Last stored block, or null when the store is empty. */
    get tip(): StoredTip | null {
        const o = this.open;
        if (!o || !o.slots.length || !this.tipHash) return null;
        return { slot: o.slots[o.slots.length - 1]!, hash: this.tipHash, chunkNo: o.chunkNo };
    }

    /**
     * Resume: count what the sink holds and reload the highest chunk as the open chunk.
     * Returns the stored tip, or null for an empty (or unreadable) store.
     */
    async resume(): Promise<StoredTip | null> {
        const names = await this.sink.list();
        const nos = names.map((n) => CHUNK_RE.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => a - b);
        this.open = null; this.stored = 0; this.storedBytes = 0; this.chunksDone = 0; this.tipHash = null;
        if (!nos.length) return null;
        // finished chunks: count blocks and bytes from their secondary index sizes
        for (const no of nos.slice(0, -1)) {
            const sec = await this.sink.read(chunkFileName(no, "secondary"));
            const chunk = await this.sink.read(chunkFileName(no, "chunk"));
            if (sec) this.stored += Math.floor(sec.length / SECONDARY_ENTRY_SIZE);
            if (chunk) this.storedBytes += chunk.length;
            this.chunksDone++;
        }
        const chunkNo = nos[nos.length - 1]!;
        const [chunk, pri, sec] = await Promise.all([this.sink.read(chunkFileName(chunkNo, "chunk")), this.sink.read(chunkFileName(chunkNo, "primary")), this.sink.read(chunkFileName(chunkNo, "secondary"))]);
        if (!chunk || !pri || !sec || pri.length < 5) return null;
        const n = Math.floor(sec.length / SECONDARY_ENTRY_SIZE);
        const entries: Uint8Array[] = [], blocks: Uint8Array[] = [], slots: number[] = [];
        for (let i = 0; i < n; i++) {
            const e = decodeSecondaryEntry(sec, i);
            const end = i + 1 < n ? decodeSecondaryEntry(sec, i + 1).blockOffset : chunk.length;
            entries.push(sec.slice(i * SECONDARY_ENTRY_SIZE, (i + 1) * SECONDARY_ENTRY_SIZE));
            blocks.push(chunk.slice(e.blockOffset, end));
            slots.push(e.slotOrEbb);
            if (i === n - 1) this.tipHash = e.headerHash;
        }
        // primary offsets up to (last filled slot + 1); a finalised chunk's padding is dropped
        const dv = new DataView(pri.buffer, pri.byteOffset);
        const all: number[] = [];
        for (let i = 1; i + 4 <= pri.length; i += 4) all.push(dv.getUint32(i, false));
        const lastRel = slots.length ? relativeSlot(slots[slots.length - 1]!, chunkNo, this.chunkSlots) : -1;
        const offsets = lastRel >= 0 ? all.slice(0, lastRel + 2) : [0];
        this.open = { chunkNo, offsets, entries, blocks, slots, bytes: chunk.length };
        this.stored += n; this.storedBytes += chunk.length;
        return this.tip;
    }

    /** Append a verified block (`[era, block]` bytes, header hash). Slots must increase. */
    async append(slot: number, hash: Uint8Array, bytes: Uint8Array): Promise<void> {
        const chunkNo = chunkNoOf(slot, this.chunkSlots);
        const o0 = this.open;
        if (o0 && chunkNo < o0.chunkNo) throw new Error(`append: slot ${slot} is below the open chunk ${o0.chunkNo}`);
        if (o0 && o0.slots.length && slot <= o0.slots[o0.slots.length - 1]!) throw new Error(`append: slot ${slot} is not after the stored tip ${o0.slots[o0.slots.length - 1]} (roll back first)`);
        if (o0 && chunkNo > o0.chunkNo) await this.finalise();
        if (!this.open) this.open = { chunkNo, offsets: [0], entries: [], blocks: [], slots: [], bytes: 0 };
        const o = this.open;
        const rel = relativeSlot(slot, chunkNo, this.chunkSlots);
        const h = locateHeader(bytes);
        const secEnd = o.entries.length * SECONDARY_ENTRY_SIZE;
        o.entries.push(encodeSecondaryEntry({ blockOffset: o.bytes, headerOffset: h.headerOffset, headerSize: h.headerSize, crc: crc32(bytes), headerHash: hash, slotOrEbb: slot }));
        while (o.offsets.length < rel + 1) o.offsets.push(secEnd);
        o.offsets.push(secEnd + SECONDARY_ENTRY_SIZE);
        o.blocks.push(bytes);
        o.slots.push(slot);
        o.bytes += bytes.length;
        this.stored++; this.storedBytes += bytes.length;
        this.tipHash = hash.slice();
        await this.flush();
    }

    /**
     * Drop every stored block with a slot after `slot` (a chain-sync RollBackward to that point).
     * Returns the number of blocks removed.
     */
    async rollbackTo(slot: number): Promise<number> {
        let removed = 0;
        // whole chunks after the point (only when a rollback crosses a chunk boundary)
        while (this.open && this.open.slots.length && this.open.slots[0]! > slot) {
            const o = this.open;
            removed += o.slots.length; this.stored -= o.slots.length; this.storedBytes -= o.bytes;
            for (const ext of ["chunk", "primary", "secondary"] as const) await this.sink.remove?.(chunkFileName(o.chunkNo, ext));
            this.open = null;
            const prev = await this.previousChunk(o.chunkNo);
            if (prev == null) { this.tipHash = null; return removed; }
            // reopen the previous chunk (it was finalised; resume() strips its padding)
            const keep = { stored: this.stored, bytes: this.storedBytes };
            await this.resumeChunk(prev);
            this.stored = keep.stored; this.storedBytes = keep.bytes;
            this.chunksDone = Math.max(0, this.chunksDone - 1);
        }
        const o = this.open;
        if (!o) return removed;
        let n = o.slots.length;
        while (n > 0 && o.slots[n - 1]! > slot) n--;
        if (n === o.slots.length) return removed;
        const drop = o.slots.length - n;
        const keptBytes = o.blocks.slice(0, n).reduce((a, b) => a + b.length, 0);
        this.stored -= drop; this.storedBytes -= o.bytes - keptBytes; removed += drop;
        o.entries.length = n; o.blocks.length = n; o.slots.length = n; o.bytes = keptBytes;
        const lastRel = n ? relativeSlot(o.slots[n - 1]!, o.chunkNo, this.chunkSlots) : -1;
        o.offsets.length = lastRel >= 0 ? lastRel + 2 : 1;
        this.tipHash = n ? decodeSecondaryEntry(o.entries[n - 1]!, 0).headerHash : null;
        await this.flush();
        return removed;
    }

    private async previousChunk(below: number): Promise<number | null> {
        const nos = (await this.sink.list()).map((n) => CHUNK_RE.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).filter((n) => n < below);
        return nos.length ? Math.max(...nos) : null;
    }

    private async resumeChunk(chunkNo: number): Promise<void> {
        const sub = new ChunkWriter({ read: (n) => this.sink.read(n), write: (n, b) => this.sink.write(n, b), list: async () => [chunkFileName(chunkNo, "chunk")] }, this.chunkSlots);
        await sub.resume();
        this.open = sub.open;
        this.tipHash = sub.tipHash;
    }

    private async flush(): Promise<void> {
        const o = this.open!;
        await this.sink.write(chunkFileName(o.chunkNo, "chunk"), concatAll(o.blocks));
        await this.sink.write(chunkFileName(o.chunkNo, "secondary"), concatAll(o.entries));
        await this.sink.write(chunkFileName(o.chunkNo, "primary"), encodePrimary(o.offsets));
    }

    /** Pad the open chunk's primary to its full length (the chunk is complete). */
    private async finalise(): Promise<void> {
        const o = this.open!;
        const want = primaryOffsetCount(this.chunkSlots);
        const last = o.offsets[o.offsets.length - 1]!;
        while (o.offsets.length < want) o.offsets.push(last);
        await this.flush();
        this.chunksDone++;
        this.open = null;
    }
}

function concatAll(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

/** In-memory sink (tests, the Bun smoke run). */
export class MemorySink implements FileSink {
    readonly files = new Map<string, Uint8Array>();
    async write(name: string, bytes: Uint8Array) { this.files.set(name, bytes.slice()); }
    async read(name: string) { return this.files.get(name) ?? null; }
    async list() { return [...this.files.keys()]; }
    async remove(name: string) { this.files.delete(name); }
    get bytes(): number { let n = 0; for (const b of this.files.values()) n += b.length; return n; }
}
