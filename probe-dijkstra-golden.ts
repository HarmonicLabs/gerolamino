import { readFileSync } from "node:fs";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { DijkstraTx } from "@harmoniclabs/cardano-ledger-ts";
import { indexBlock } from "./src/node/localIndex";
import { ledgerDiffFromBlock } from "./src/node/ledgerApply";
import { arrayElements } from "./src/node/cbor";

const DIR = new URL("./test/fixtures/dijkstra/", import.meta.url);
const file = (n: string) => fromHex(readFileSync(new URL(n, DIR), "utf8").replace(/\s+/g, ""));
const header = file("musashi_type8_dijkstra_header.hex");
const txBytes = file("cardano_ledger_golden_tx.hex");
const ranged = (b: Uint8Array, i: number): Uint8Array => {
    const r = arrayElements(b, 0)[i]!;
    return b.subarray(r.start, r.end);
};
const cat = (...xs: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
    let p = 0; for (const x of xs) { out.set(x, p); p += x.length; }
    return out;
};
const blockTransaction = (tx: Uint8Array, valid = true): Uint8Array =>
    cat(new Uint8Array([0x84]), ranged(tx, 0), ranged(tx, 1), ranged(tx, 2), new Uint8Array([valid ? 0xf5 : 0xf4]));
const blockBody = cat(new Uint8Array([0x83, 0x81]), blockTransaction(txBytes), new Uint8Array([0xf6, 0xf6]));
const block = new Uint8Array([0x82, 0x08, ...cat(new Uint8Array([0x82]), header, blockBody)]);
const tx = DijkstraTx.fromCbor(txBytes);
console.log({ hashTx: toHex(tx.hashTx()), hashTxBytes: toHex(DijkstraTx.hashTxBytes(txBytes)), valid: tx.isScriptValid });
const ib = indexBlock(block);
console.log("index", { era: ib.eraTag, txs: ib.txs.length, valid: ib.txs.map((t) => t.valid), hashes: ib.txs.map((t) => t.hash) });
const d = ledgerDiffFromBlock(block, 999, "aa".repeat(32));
console.log("diff", { txs: d.txs, invalid: d.invalidTx, created: d.created.length, spent: d.spent.length, fees: d.p2?.fees });
