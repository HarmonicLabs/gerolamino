import { describe, expect, test } from "bun:test";
import { CborArray, CborBytes, CborTag, CborUInt } from "@harmoniclabs/cbor";
import { bodyHashOf, lastPointOfChunk, summarizeHeader } from "../src/node/browserNode";
import { locateHeader } from "../src/node/chunkFormat";
import { blocksInRange, blocksOfChunk, bytesToHex, hasChunk, preprodFixture, PREVIEW_IMMUTABLE, readChunkFiles } from "./lib/chunkReader";

const rollForwardData = (eraTag: number, header: Uint8Array) => new CborArray([new CborUInt(eraTag - 1), new CborTag(24n, new CborBytes(header))]);

describe("header summary and body binding (fixture)", () => {
    test("preprod Shelley and Conway blocks: header fields, hashTxSeq and body size agree", () => {
        const fx = preprodFixture();
        for (const block of [fx.shelley, fx.conway]) {
            const eraTag = block[1]!;
            const l = locateHeader(block);
            const h = summarizeHeader(rollForwardData(eraTag, block.subarray(l.headerOffset, l.headerOffset + l.headerSize)));
            const body = bodyHashOf(block);
            expect(body.eraTag).toBe(eraTag);
            expect(body.hash).toBe(h.bodyHash);
            expect(body.size).toBe(h.bodySize);
        }
    });
    test("Byron headers are refused with a clear error", () => {
        expect(() => summarizeHeader(new CborArray([new CborUInt(0), new CborTag(24n, new CborBytes(new Uint8Array([0x80])))]))).toThrow(/Byron/);
    });
});

describe.skipIf(!hasChunk(PREVIEW_IMMUTABLE, 28000) || !hasChunk(PREVIEW_IMMUTABLE, 1000))("header summary and hashTxSeq against cardano-node's stored blocks (preview, Conway and Babbage)", () => {
    test("hash, slot, prev link, body hash and body size", () => {
        let n = 0;
        for (const [a, b] of [[28000 * 4320, 28000 * 4320 + 600], [1000 * 4320, 1000 * 4320 + 600]] as const) {
            let prev: string | null = null;
            for (const blk of blocksInRange(PREVIEW_IMMUTABLE, 4320, a, b)) {
                const eraTag = blk.bytes[1]!;
                const h = summarizeHeader(rollForwardData(eraTag, blk.bytes.slice(blk.headerOffset, blk.headerOffset + blk.headerSize)));
                expect(h.slot).toBe(blk.slot);
                expect(h.hash).toBe(bytesToHex(blk.hash));
                if (prev) expect(h.prevHash).toBe(prev);
                prev = h.hash;
                const body = bodyHashOf(blk.bytes);
                expect(body.hash).toBe(h.bodyHash);
                expect(body.size).toBe(h.bodySize);
                expect(body.eraTag).toBe(eraTag);
                n++;
            }
        }
        expect(n).toBeGreaterThan(30);
    });
    test("lastPointOfChunk is the chunk's last block (the 'chunk' start mode)", () => {
        const f = readChunkFiles(PREVIEW_IMMUTABLE, 28000);
        const last = blocksOfChunk(PREVIEW_IMMUTABLE, 28000).at(-1)!;
        expect(lastPointOfChunk(f.primary, f.secondary)).toEqual({ slot: last.slot, hash: bytesToHex(last.hash) });
    });
});
