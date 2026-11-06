import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DijkstraHeader, DijkstraTx, MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { summarizeHeaderBytes, bodyHashOf } from "../src/node/browserNode";
import { parseHeaderCrypto, verifyHeaderCrypto } from "../src/node/headerVerify";
import { ledgerDiffFromBlock } from "../src/node/ledgerApply";
import { indexBlock } from "../src/node/localIndex";
import { arrayElements } from "../src/node/cbor";

const DIR = new URL("./fixtures/dijkstra/", import.meta.url);
const file = (n: string) => fromHex(readFileSync(new URL(n, DIR), "utf8").replace(/\s+/g, ""));
const header = file("musashi_type8_dijkstra_header.hex");
const rawBlock = file("musashi_type8_dijkstra_block.hex");
const wrap8 = (b: Uint8Array): Uint8Array => new Uint8Array([0x82, 0x08, ...b]);
const cat = (...xs: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
    let p = 0; for (const x of xs) { out.set(x, p); p += x.length; }
    return out;
};
const ranged = (b: Uint8Array, i: number): Uint8Array => {
    const r = arrayElements(b, 0)[i]!;
    return b.subarray(r.start, r.end);
};

/** A block-format transaction from a mempool transaction: [body, wits, aux/nil, is_valid]. */
function blockTransaction(txBytes: Uint8Array, valid = true): Uint8Array {
    return cat(new Uint8Array([0x84]), ranged(txBytes, 0), ranged(txBytes, 1), ranged(txBytes, 2), new Uint8Array([valid ? 0xf5 : 0xf4]));
}

/** A Dijkstra block ([era 8, [header, block_body([txs], leios/nil, peras/nil])]) carrying one golden transaction. */
function goldenBlock(txBytes: Uint8Array): Uint8Array {
    const blockBody = cat(new Uint8Array([0x83, 0x81]), blockTransaction(txBytes), new Uint8Array([0xf6, 0xf6]));
    return wrap8(cat(new Uint8Array([0x82]), header, blockBody));
}

describe("Dijkstra in Gerolamino", () => {
    test("a 12-field header parses its Praos fields and body commitment", () => {
        const s = summarizeHeaderBytes(header, 8);
        const h = DijkstraHeader.fromCbor(header);
        expect(s.eraTag).toBe(8);
        expect(s.slot).toBe(s.slot);
        expect(s.blockNo).toBe(4329);
        expect(Number(h.body.blockNumber)).toBe(s.blockNo);
        expect(Number(h.body.slot)).toBe(s.slot);
        expect(Number(h.body.blockBodySize)).toBe(s.bodySize);
        expect(toHex(h.body.blockBodyHash)).toBe(s.bodyHash);
        expect(toHex(h.body.issuerPubKey)).toBe(toHex(parseHeaderCrypto(header, 8).issuerVkey));
    });

    test("a live Musashi block_body hashes and sizes exactly as its header says", () => {
        const s = summarizeHeaderBytes(header, 8);
        expect(bodyHashOf(wrap8(rawBlock))).toEqual({ hash: s.bodyHash, eraTag: 8, txs: 0, size: s.bodySize });
        expect(bodyHashOf(wrap8(rawBlock)).size).toBe(4);
        expect(bodyHashOf(wrap8(rawBlock)).hash).toBe("c93a1b1497883589d7ec8abb158c9b66c311ac8d45be74610bf889443daec967");
    });

    test("block decode, ledger diff and index agree on the empty Musashi block", () => {
        const m = MultiEraBlock.fromCbor(wrap8(rawBlock));
        expect(m.era).toBe(8);
        expect((m.block as any).transactions.length).toBe(0);
        const d = ledgerDiffFromBlock(wrap8(rawBlock), 566037, "aa".repeat(32));
        expect(d.txs).toBe(0);
        expect(d.created.length + d.spent.length + d.invalidTx.length).toBe(0);
        expect(d.p2!.fees).toBe("0");
        expect(indexBlock(wrap8(rawBlock)).eraTag).toBe(8);
        expect(indexBlock(wrap8(rawBlock)).txs.length).toBe(0);
    });

    test("the live legacy Musashi header passes opcert and KES under the same parser", () => {
        const legacy = file("musashi_legacy_block_566037.hex");
        const legacyHeader = ranged(legacy, 0);
        const hc = parseHeaderCrypto(legacyHeader, 8);
        const r = verifyHeaderCrypto(hc, new Uint8Array(32), 129600, 62);
        expect(r.opcertOk).toBe(true);
        expect(r.kesOk).toBe(true);
        expect(r.detail.filter((x) => x.includes("KES signature"))).toEqual([]);
    });

    test("the golden Dijkstra transaction decodes with the ledger's own hashTx", () => {
        const bytes = file("cardano_ledger_golden_tx.hex");
        const tx = DijkstraTx.fromCbor(bytes);
        expect(tx.isScriptValid).toBe(true);
        expect((tx as any).body.outputs.length).toBe(11);
        expect((tx as any).body.subTransactions.length).toBe(1);
        expect(toHex(tx.hashTx())).toBe(readFileSync(new URL("cardano_ledger_golden_hashtx.hex", DIR), "utf8").trim());
    });

    test("a block with a real Dijkstra transaction projects top-level and sub-transaction UTxO effects", () => {
        const bytes = goldenBlock(file("cardano_ledger_golden_tx.hex"));
        const m = MultiEraBlock.fromCbor(bytes);
        expect(m.era).toBe(8);
        expect((m.block as any).transactions.length).toBe(1);
        expect((m.block as any).transactionBodies.length).toBe(1);
        const d = ledgerDiffFromBlock(bytes, 999, "aa".repeat(32));
        expect(d.txs).toBe(1);
        expect(d.invalidTx).toEqual([]);
        expect(d.created.length).toBe(22); // 11 top-level + 11 sub-transaction outputs
        expect(d.spent.length).toBe(1);
        expect(d.created[0]!.ref).toContain(":");
        expect(d.p2!.fees).toBe("3");
        expect(d.p2!.deposits).toBe("2000000");
        expect(d.p2!.withdrawals).toBe("200");
        expect(d.p2!.governanceDeposits.length).toBe(14);
        const idx = indexBlock(bytes);
        expect(idx.eraTag).toBe(8);
        expect(idx.txs.length).toBe(1);
        expect(idx.txs[0]!.valid).toBe(true);
        expect(idx.txs[0]!.outputs).toBe(11);
        expect(idx.txs[0]!.fees).toBe(3n);
    });
});
