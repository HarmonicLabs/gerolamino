import { MultiEraBlock, DijkstraBlock, DijkstraHeader, DijkstraTxBody, DijkstraTx } from "/media/bakon/data/Dev/HarmonicLabs/cardano-ledger-ts/dist/index.js";
import { readFileSync } from "node:fs";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
const DIR = "/media/bakon/data/Dev/HarmonicLabs/gerolamo/src/consensus/__fixtures__/dijkstra";
const raw = fromHex(readFileSync(`${DIR}/musashi_type8_dijkstra_block.hex`, "utf8").trim());
try {
    const m: any = MultiEraBlock.fromCbor(new Uint8Array([0x82, 0x08, ...raw]));
    console.log("MultiEraBlock era", m.era, "block", m.block?.constructor?.name, "txs", m.block?.transactionBodies?.length, "invalid", m.block?.invalidTransactions?.length, "header keys", Object.keys(m.block.header));
    const b: any = DijkstraBlock.fromCbor(raw);
    console.log("DijkstraBlock keys", Object.keys(b), "txs", b.transactions?.length, "leios", b.leiosCertificate?.constructor?.name, "peras", b.perasCertificate?.constructor?.name, "headerbody keys", Object.keys(b.header.body), "certified", b.header.body.leiosCertified);
    const hdr = DijkstraHeader.fromCbor(fromHex(readFileSync(`${DIR}/musashi_type8_dijkstra_header.hex`, "utf8").trim()));
    console.log("header body keys", Object.keys((hdr as any).body ?? hdr), "header keys", Object.keys(hdr as any));
    const txBytes = fromHex(readFileSync(`${DIR}/cardano_ledger_golden_tx.hex`, "utf8").trim());
    const tx: any = DijkstraTx.fromCbor(txBytes);
    console.log("tx keys", Object.keys(tx), "body keys", Object.keys(tx.body ?? {}), "hashTx", toHex(tx.hashTx?.() ?? tx.body?.hashTx?.() ?? new Uint8Array()));
} catch (e) { console.error((e as Error).stack); process.exit(1); }
