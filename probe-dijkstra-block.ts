import { readFileSync } from "node:fs";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { ledgerDiffFromBlock } from "./src/node/ledgerApply";
import { arrayElements } from "./src/node/cbor";
const DIR = "/media/bakon/data/Dev/HarmonicLabs/gerolamo/src/consensus/__fixtures__/dijkstra";
const header = fromHex(readFileSync(`${DIR}/musashi_type8_dijkstra_header.hex`, "utf8").trim());
const txBytes = fromHex(readFileSync(`${DIR}/cardano_ledger_golden_tx.hex`, "utf8").trim());
const cat = (...xs: Uint8Array[]) => { const o = new Uint8Array(xs.reduce((a, x) => a + x.length, 0)); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; };
const r = (b: Uint8Array, i: number) => b.subarray(arrayElements(b, 0)[i]!.start, arrayElements(b, 0)[i]!.end);
const blockTx = cat(new Uint8Array([0x84]), r(txBytes, 0), r(txBytes, 1), r(txBytes, 2), new Uint8Array([0xf5]));
const blockBody = cat(new Uint8Array([0x83, 0x81]), blockTx, new Uint8Array([0xf6, 0xf6]));
const block = cat(new Uint8Array([0x82]), header, blockBody);
const wrapped = cat(new Uint8Array([0x82, 0x08]), block);
try {
    const m: any = MultiEraBlock.fromCbor(wrapped);
    console.log("block", m.era, m.block.constructor.name, "txs", m.block.transactions?.length, "bodies", m.block.transactionBodies?.length, "invalid", m.block.invalidTransactions);
    const d = ledgerDiffFromBlock(wrapped, 999, "aa".repeat(32));
    console.log("diff", { txs: d.txs, invalid: d.invalidTx, created: d.created.length, spent: d.spent.length, createdFirst: d.created.slice(0, 2).map((x) => x.ref), spentFirst: d.spent.slice(0, 2), p2Fees: d.p2?.fees, p2Deposits: d.p2?.deposits, p2Withdraw: d.p2?.withdrawals, gov: d.p2?.governanceDeposits.length, stakeReg: d.p2?.stakeRegistered.length, poolReg: d.p2?.poolRegistrations.length, minted: d.p2?.minted.length });
} catch (e) { console.error((e as Error).stack); }
