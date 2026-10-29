import { describe, expect, test } from "bun:test";
import { MemorySink } from "../src/node/chunkWriter";
import { MITHRIL_ANCHOR_FILE, readMithrilAnchor, writeMithrilAnchor } from "../src/node/mithrilAnchorStore";
import type { MithrilAnchor } from "../src/node/mithrilLoader";

const anchor = (slot: number, hash = "ab".repeat(32)): MithrilAnchor => ({
    network: "preview", snapshotHash: "s", certificateHash: "c", epoch: 1459, immutableFileNumber: 28001,
    merkleRoot: "m", chunkNo: 28001, slot, hash, blocksInChunk: 1, certificatesWalked: "330",
    genesisCertificateHash: "g",
    chain: { certificates: 330, cacheHits: 1, downloads: 329, walkMs: 1, verifyMs: 1 },
    digestsSource: "peer", digestsMs: 1,
});

describe("Mithril anchor file", () => {
    test("writes the certified point next to the store, and resume reads it", async () => {
        const sink = new MemorySink();
        expect(await writeMithrilAnchor(sink, anchor(126_581_050), "preview")).toBe(true);
        expect(sink.files.has(MITHRIL_ANCHOR_FILE)).toBe(true);
        const read = await readMithrilAnchor(sink, 126_581_173);
        expect(read?.slot).toBe(126_581_050);
        expect(read?.hash).toBe("ab".repeat(32));
        expect(read?.network).toBe("preview");
    });

    test("an anchor above the stored tip is stale; corrupt and absent files read null; no sink writes nothing", async () => {
        const sink = new MemorySink();
        await writeMithrilAnchor(sink, anchor(100), "preview");
        expect((await readMithrilAnchor(sink, 99))?.slot).toBeUndefined();
        expect(await readMithrilAnchor(sink, 99)).toBeNull();
        expect((await readMithrilAnchor(sink, 100))?.slot).toBe(100);
        sink.files.set(MITHRIL_ANCHOR_FILE, new Uint8Array([0x7b, 0x7d])); // {}
        expect(await readMithrilAnchor(sink, 200)).toBeNull();
        sink.files.set(MITHRIL_ANCHOR_FILE, new Uint8Array([0x6e, 0x6f])); // "no", invalid JSON
        expect(await readMithrilAnchor(sink, 200)).toBeNull();
        expect(await readMithrilAnchor(new MemorySink(), 200)).toBeNull();
        expect(await writeMithrilAnchor(undefined, anchor(1), "preview")).toBe(false);
    });

    test("a bad hash or slot is rejected", async () => {
        const sink = new MemorySink();
        sink.files.set(MITHRIL_ANCHOR_FILE, new TextEncoder().encode(JSON.stringify({ slot: 5, hash: "zz" })));
        expect(await readMithrilAnchor(sink, 10)).toBeNull();
        sink.files.set(MITHRIL_ANCHOR_FILE, new TextEncoder().encode(JSON.stringify({ slot: -1, hash: "ab".repeat(32) })));
        expect(await readMithrilAnchor(sink, 10)).toBeNull();
        sink.files.set(MITHRIL_ANCHOR_FILE, new TextEncoder().encode(JSON.stringify({ slot: 5.5, hash: "ab".repeat(32) })));
        expect(await readMithrilAnchor(sink, 10)).toBeNull();
    });
});
