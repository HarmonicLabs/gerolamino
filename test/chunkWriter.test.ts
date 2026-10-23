import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChunkWriter, MemorySink } from "../src/node/chunkWriter";
import { crc32, decodePrimary, filledRelativeSlots, locateHeader, primaryFileSize, relativeSlot } from "../src/node/chunkFormat";
import { blocksInRange, hasChunk, PREVIEW_IMMUTABLE } from "./lib/chunkReader";

const C = 4320;
const eq = (a: Uint8Array | null, b: Uint8Array) => !!a && a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
const nodeFile = (name: string) => new Uint8Array(readFileSync(join(PREVIEW_IMMUTABLE, name)));

describe.skipIf(!hasChunk(PREVIEW_IMMUTABLE, 28001))("chunk writer against cardano-node's own chunk files (preview)", () => {
    const blocks = blocksInRange(PREVIEW_IMMUTABLE, C, 28000 * C, 28001 * C + 800);

    test("a full chunk fed from its first block is byte-identical to the node's files; the open chunk is a prefix; resume continues", async () => {
        const first = blocks.filter((b) => b.slot <= 28001 * C + 200);
        const sink = new MemorySink();
        const w = new ChunkWriter(sink, C);
        for (const b of first) await w.append(b.slot, b.hash, b.bytes);
        for (const ext of ["chunk", "secondary", "primary"] as const) expect(eq(await sink.read(`28000.${ext}`), nodeFile(`28000.${ext}`))).toBe(true);
        expect(w.stats.blocks).toBe(first.length);
        const theirs = nodeFile("28001.chunk");
        const ours = (await sink.read("28001.chunk"))!;
        expect(eq(theirs.subarray(0, ours.length), ours)).toBe(true);
        expect(crc32(first[0]!.bytes)).toBe(Bun.hash.crc32(first[0]!.bytes) >>> 0);
        // resume from the sink and continue
        const w2 = new ChunkWriter(sink, C);
        const tip = await w2.resume();
        expect(tip!.slot).toBe(first[first.length - 1]!.slot);
        expect(Buffer.from(tip!.hash).toString("hex")).toBe(Buffer.from(first[first.length - 1]!.hash).toString("hex"));
        expect(w2.stats.blocks).toBe(first.length);
        for (const b of blocks.slice(first.length)) await w2.append(b.slot, b.hash, b.bytes);
        const ours2 = (await sink.read("28001.chunk"))!;
        expect(ours2.length).toBeGreaterThan(ours.length);
        expect(eq(theirs.subarray(0, ours2.length), ours2)).toBe(true);
        expect(eq(await sink.read("28000.primary"), nodeFile("28000.primary"))).toBe(true);
    }, 60_000);

    test("a mid-chunk start (light client from the tip) yields a valid index with exactly the stored slots", async () => {
        const sink = new MemorySink();
        const w = new ChunkWriter(sink, C);
        const mid = blocks.slice(50, 80);
        for (const b of mid) await w.append(b.slot, b.hash, b.bytes);
        const offs = decodePrimary((await sink.read("28000.primary"))!);
        expect(filledRelativeSlots(offs)).toEqual(mid.map((b) => relativeSlot(b.slot, 28000, C)));
    });

    test("rollback truncates the open chunk to a prefix of the node's files, and re-appending restores them", async () => {
        const first = blocks.filter((b) => b.slot < 28000 * C + 3000);
        const sink = new MemorySink();
        const w = new ChunkWriter(sink, C);
        for (const b of first) await w.append(b.slot, b.hash, b.bytes);
        const keep = first.length - 7;
        const removed = await w.rollbackTo(first[keep - 1]!.slot);
        expect(removed).toBe(7);
        expect(w.tip!.slot).toBe(first[keep - 1]!.slot);
        expect(w.stats.blocks).toBe(keep);
        const ch = (await sink.read("28000.chunk"))!;
        expect(eq(nodeFile("28000.chunk").subarray(0, ch.length), ch)).toBe(true);
        expect(filledRelativeSlots(decodePrimary((await sink.read("28000.primary"))!)).length).toBe(keep);
        await expect(w.append(first[0]!.slot, first[0]!.hash, first[0]!.bytes)).rejects.toThrow(/not after the stored tip/);
        for (const b of first.slice(keep)) await w.append(b.slot, b.hash, b.bytes);
        const again = (await sink.read("28000.chunk"))!;
        expect(eq(nodeFile("28000.chunk").subarray(0, again.length), again)).toBe(true);
    });

    test("a rollback across a chunk boundary removes the later chunk and reopens the earlier one", async () => {
        const sink = new MemorySink();
        const w = new ChunkWriter(sink, C);
        for (const b of blocks) await w.append(b.slot, b.hash, b.bytes);
        expect(sink.files.has("28001.chunk")).toBe(true);
        expect((await sink.read("28000.primary"))!.length).toBe(primaryFileSize(C));
        const lastOf28000 = blocks.filter((b) => b.slot < 28001 * C).at(-1)!;
        await w.rollbackTo(lastOf28000.slot - 1);
        expect(sink.files.has("28001.chunk")).toBe(false);
        expect(w.tip!.slot).toBeLessThan(lastOf28000.slot);
        const ch = (await sink.read("28000.chunk"))!;
        expect(eq(nodeFile("28000.chunk").subarray(0, ch.length), ch)).toBe(true);
        // and it can roll forward again into a byte-identical chunk 28000
        for (const b of blocks.filter((b) => b.slot > w.tip!.slot)) await w.append(b.slot, b.hash, b.bytes);
        for (const ext of ["chunk", "secondary", "primary"] as const) expect(eq(await sink.read(`28000.${ext}`), nodeFile(`28000.${ext}`))).toBe(true);
    });
});

describe("chunk writer (synthetic blocks)", () => {
    // a minimal disk block `[7, [header, [], [], {}, []]]` whose header is [[blockNo, slot]] — enough for locateHeader
    const block = (slot: number) => new Uint8Array([0x82, 0x07, 0x85, 0x81, 0x82, 0x1a, ...u32(slot), 0x1a, ...u32(slot), 0x80, 0x80, 0xa0, 0x80]);
    function u32(n: number) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
    const hash = (n: number) => new Uint8Array(32).fill(n & 0xff);

    test("locateHeader finds the header in a disk block", () => {
        const l = locateHeader(block(100));
        expect(l.headerOffset).toBe(3);
        expect(l.eraTag).toBe(7);
        expect(l.headerSize).toBe(12);
    });

    test("an empty store resumes to null; slots must increase; rollback to before the first block empties it", async () => {
        const sink = new MemorySink();
        const w = new ChunkWriter(sink, 100);
        expect(await w.resume()).toBeNull();
        await w.append(105, hash(1), block(105));
        await w.append(110, hash(2), block(110));
        await expect(w.append(110, hash(3), block(110))).rejects.toThrow();
        expect(await w.rollbackTo(104)).toBe(2);
        expect(w.tip).toBeNull();
        expect(w.stats.blocks).toBe(0);
        await w.append(107, hash(4), block(107));
        expect(w.tip!.slot).toBe(107);
        const r = await new ChunkWriter(sink, 100).resume();
        expect(r!.slot).toBe(107);
    });

    test("stats count blocks, bytes and chunks across finished chunks after resume", async () => {
        const sink = new MemorySink();
        const w = new ChunkWriter(sink, 100);
        const slots = [5, 50, 150, 160, 250];
        for (const s of slots) await w.append(s, hash(s), block(s));
        expect(w.stats.chunks).toBe(3);
        const w2 = new ChunkWriter(sink, 100);
        await w2.resume();
        expect(w2.stats).toEqual({ ...w.stats });
    });
});
