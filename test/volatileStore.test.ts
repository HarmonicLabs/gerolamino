import { describe, expect, test } from "bun:test";
import { ChunkWriter, MemorySink } from "../src/node/chunkWriter";
import { VolatileStore } from "../src/node/volatileStore";
import { chunkFileName, locateHeader } from "../src/node/chunkFormat";
// a minimal disk block `[7, [header, [], [], {}, []]]` whose header is [[blockNo, slot]] — enough for locateHeader
function u32(n: number) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
const block = (slot: number) => new Uint8Array([0x82, 0x07, 0x85, 0x81, 0x82, 0x1a, ...u32(slot), 0x1a, ...u32(slot), 0x80, 0x80, 0xa0, 0x80]);
const hash = (n: number) => new Uint8Array(32).fill(n & 0xff);

describe("volatile store", () => {
    test("empty resume, append, tip, and reload across instances", async () => {
        const sink = new MemorySink();
        const v = new VolatileStore(sink);
        expect(await v.resume()).toBeNull();
        await v.append(105, hash(1), block(105));
        await v.append(110, hash(2), block(110));
        expect(v.tip!.slot).toBe(110);
        expect(v.stats.blocks).toBe(2);
        const v2 = new VolatileStore(sink);
        const tip = await v2.resume();
        expect(tip!.slot).toBe(110);
        expect(Buffer.from(tip!.hash).toString("hex")).toBe(Buffer.from(hash(2)).toString("hex"));
        expect(v2.stats.blocks).toBe(2);
    });

    test("slots must increase; rollback drops the files after the point and keeps the rest", async () => {
        const sink = new MemorySink();
        const v = new VolatileStore(sink);
        for (const s of [100, 101, 102, 103]) await v.append(s, hash(s), block(s));
        await expect(v.append(103, hash(9), block(103))).rejects.toThrow(/not after the stored tip/);
        expect(await v.rollbackTo(101)).toBe(2);
        expect(v.tip!.slot).toBe(101);
        expect(sink.files.has("v-0000000102.blk")).toBe(false);
        expect(sink.files.has("v-0000000103.blk")).toBe(false);
        expect(sink.files.has("v-0000000101.blk")).toBe(true);
        expect(await v.rollbackTo(90)).toBe(2);
        expect(v.tip).toBeNull();
        expect(v.stats).toEqual({ blocks: 0, bytes: 0 });
    });

    test("promotion takes only blocks at or below the cutoff, oldest first, and removes their files", async () => {
        const sink = new MemorySink();
        const v = new VolatileStore(sink);
        for (const s of [200, 201, 202, 203, 204]) await v.append(s, hash(s), block(s));
        const promoted = await v.promoteOlderThan(202);
        expect(promoted.map((p) => p.slot)).toEqual([200, 201, 202]);
        expect(v.stats.blocks).toBe(2);
        expect(v.tip!.slot).toBe(204);
        expect(sink.files.has("v-0000000200.blk")).toBe(false);
        expect(sink.files.has("v-0000000204.blk")).toBe(true);
        expect(await v.promoteOlderThan(199)).toEqual([]);
        const v2 = new VolatileStore(sink);
        expect((await v2.resume())!.slot).toBe(204);
    });

    test("a torn volatile file is skipped on resume", async () => {
        const sink = new MemorySink();
        const v = new VolatileStore(sink);
        await v.append(300, hash(1), block(300));
        sink.files.set("v-0000000301.blk", new Uint8Array(10)); // shorter than hash + 1
        const v2 = new VolatileStore(sink);
        expect((await v2.resume())!.slot).toBe(300);
        expect(v2.stats.blocks).toBe(1);
    });
});

describe("volatile + immutable store together", () => {
    test("chunk files only hold promoted (immutable) blocks; rollback inside k leaves them untouched", async () => {
        const sink = new MemorySink();
        const vSink = new MemorySink();
        const C = 100;
        const writer = new ChunkWriter(sink, C);
        const v = new VolatileStore(vSink);
        const slots = Array.from({ length: 11 }, (_, i) => 505 + i);
        for (const s of slots) {
            await v.append(s, hash(s), block(s));
            const promoted = await v.promoteOlderThan(s - 5); // k = 5 slots
            for (const p of promoted) await writer.append(p.slot, p.hash, p.bytes);
        }
        expect(v.stats.blocks).toBe(5);          // 510..515
        expect(writer.stats.blocks).toBe(6);     // 505..510 promoted
        expect(v.tip!.slot).toBe(515);
        expect(writer.tip!.slot).toBe(510);
        expect(sink.files.has(chunkFileName(5, "chunk"))).toBe(true);
        const before = sink.files.get(chunkFileName(5, "chunk"))!.slice();
        // rollback inside the volatile window: chunk files unchanged
        expect(await v.rollbackTo(512)).toBe(3);
        expect(v.tip!.slot).toBe(512);
        expect(writer.stats.blocks).toBe(6);
        expect(Buffer.from(sink.files.get(chunkFileName(5, "chunk"))!)).toEqual(Buffer.from(before));
        // resume: immutable tip from chunks, volatile tip from its files
        const w2 = new ChunkWriter(sink, C);
        const wTip = await w2.resume();
        expect(wTip!.slot).toBe(510);
        const v2 = new VolatileStore(vSink);
        expect((await v2.resume())!.slot).toBe(512);
    });

    test("a deep rollback past the volatile window truncates the chunk writer and drops volatile", async () => {
        const sink = new MemorySink();
        const vSink = new MemorySink();
        const C = 100;
        const writer = new ChunkWriter(sink, C);
        const v = new VolatileStore(vSink);
        const slots = Array.from({ length: 8 }, (_, i) => 600 + i);
        for (const s of slots) {
            await v.append(s, hash(s), block(s));
            for (const p of await v.promoteOlderThan(s - 3)) await writer.append(p.slot, p.hash, p.bytes);
        }
        expect(writer.tip!.slot).toBe(604); // 600..604 promoted
        expect(v.tip!.slot).toBe(607);
        expect(await v.rollbackTo(602)).toBe(3); // 605..607
        expect(await writer.rollbackTo(602)).toBe(2); // 603, 604 gone
        expect(writer.tip!.slot).toBe(602);
        expect(v.tip).toBeNull(); // everything volatile was promoted already
        const loc = locateHeader(block(602));
        expect(loc.eraTag).toBe(7);
    });
});
