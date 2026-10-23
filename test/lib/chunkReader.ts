/** Test helper: read blocks out of a cardano-node immutable directory with Gerolamino's own chunkFormat. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkFileName, decodePrimary, decodeSecondaryEntry, filledRelativeSlots, SECONDARY_ENTRY_SIZE } from "../../src/node/chunkFormat";

export const PREVIEW_IMMUTABLE = process.env.GEROLAMINO_PREVIEW_IMMUTABLE ?? "/media/bakon/data/cardano/cardano-node/preview-relay/db/immutable";

export interface StoredBlock { slot: number; hash: Uint8Array; bytes: Uint8Array; headerOffset: number; headerSize: number }

export function hasChunk(dir: string, chunkNo: number): boolean {
    return existsSync(join(dir, chunkFileName(chunkNo, "primary")));
}

export function readChunkFiles(dir: string, chunkNo: number): { chunk: Uint8Array; primary: Uint8Array; secondary: Uint8Array } {
    const r = (ext: "chunk" | "primary" | "secondary") => new Uint8Array(readFileSync(join(dir, chunkFileName(chunkNo, ext))));
    return { chunk: r("chunk"), primary: r("primary"), secondary: r("secondary") };
}

export function blocksOfChunk(dir: string, chunkNo: number): StoredBlock[] {
    const { chunk, primary, secondary } = readChunkFiles(dir, chunkNo);
    const filled = filledRelativeSlots(decodePrimary(primary));
    const n = secondary.length / SECONDARY_ENTRY_SIZE;
    const out: StoredBlock[] = [];
    for (let i = 0; i < n; i++) {
        const e = decodeSecondaryEntry(secondary, i, filled[i] === 0);
        const end = i + 1 < n ? decodeSecondaryEntry(secondary, i + 1).blockOffset : chunk.length;
        out.push({ slot: e.slotOrEbb, hash: e.headerHash, bytes: chunk.slice(e.blockOffset, end), headerOffset: e.headerOffset, headerSize: e.headerSize });
    }
    return out;
}

export function blocksInRange(dir: string, chunkSlots: number, fromSlot: number, toSlot: number): StoredBlock[] {
    const out: StoredBlock[] = [];
    for (let c = Math.floor(fromSlot / chunkSlots); c <= Math.floor(toSlot / chunkSlots); c++) {
        if (!hasChunk(dir, c)) continue;
        for (const b of blocksOfChunk(dir, c)) if (b.slot >= fromSlot && b.slot <= toSlot) out.push(b);
    }
    return out;
}

export const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
export const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The preprod fixture: the first Shelley block (TPraos, epoch 4) and a Conway block (Praos, epoch 310). */
export function preprodFixture() {
    const fx = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/shelley-conway-preprod.json"), "utf8")) as { blocks: Record<string, string> };
    return {
        shelley: hexToBytes(fx.blocks.shelley_86400!),
        conway: hexToBytes(fx.blocks.tip!),
        nonceEpoch4: hexToBytes("162d29c4e1cf6b8a84f2d692e67a3ac6bc7851bc3e6e4afe64d15778bed8bd86"),
        nonceEpoch310: hexToBytes("7c00177d24bfbdb3e908f7a792758fe54ccfa634ccf719d81a95b89655dadd35"),
    };
}
