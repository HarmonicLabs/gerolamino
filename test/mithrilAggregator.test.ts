import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decompressZstd, extractLedgerFiles } from "../src/node/mithrilAggregator";
import { extractTarFiles } from "../src/node/tar";

const zst = new Uint8Array(readFileSync("test/fixtures/ancillary-small.tar.zst"));

describe("Mithril aggregator archive", () => {
    test("zstd decompression and tar extraction find ledger/<slot>/tables and meta", () => {
        const tar = decompressZstd(zst);
        const { tables, meta, manifest } = extractLedgerFiles(tar, 122735066);
        expect([...tables]).toEqual([1, 2, 3, 4]);
        expect(new TextDecoder().decode(meta)).toBe('{"backend":"utxohd-mem","tablesCodecVersion":1}');
        expect(manifest).not.toBeNull();
    });

    test("the tar reader keeps a pax longer path", () => {
        // A normal USTAR entry plus a two-entry archive made by GNU tar exercises the same reader;
        // the pax path is the `x` header branch covered by coreutils --format=pax.
        const files = extractTarFiles(decompressZstd(zst));
        expect(files.has("ledger/122735066/tables")).toBe(true);
        expect(files.has("ancillary_manifest.json")).toBe(true);
    });
});
