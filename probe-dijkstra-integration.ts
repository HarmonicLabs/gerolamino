import { readFileSync } from "node:fs";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { summarizeHeaderBytes, bodyHashOf } from "./src/node/browserNode";
import { parseHeaderCrypto, verifyHeaderCrypto } from "./src/node/headerVerify";
import { ledgerDiffFromBlock } from "./src/node/ledgerApply";
import { indexBlock } from "./src/node/localIndex";
const DIR = "/media/bakon/data/Dev/HarmonicLabs/gerolamo/src/consensus/__fixtures__/dijkstra";
const header = fromHex(readFileSync(`${DIR}/musashi_type8_dijkstra_header.hex`, "utf8").trim());
const raw = fromHex(readFileSync(`${DIR}/musashi_type8_dijkstra_block.hex`, "utf8").trim());
const block = new Uint8Array(raw.length + 2); block[0] = 0x82; block[1] = 8; block.set(raw, 2);
const s = summarizeHeaderBytes(header, 8);
console.log("summary", { era: s.eraTag, slot: s.slot, blockNo: s.blockNo, bodySize: s.bodySize, bodyHash: s.bodyHash });
try {
    const hc = parseHeaderCrypto(header, 8);
    const r = verifyHeaderCrypto(hc, new Uint8Array(32), 129600, 62);
    console.log("header crypto", r);
} catch (e) { console.log("header crypto ERR", (e as Error).message); }
try { console.log("bodyHashOf", bodyHashOf(block)); } catch (e) { console.log("bodyHashOf ERR", (e as Error).message); }
try { const d = ledgerDiffFromBlock(block, 566037, "aa".repeat(32)); console.log("ledger diff", { txs: d.txs, created: d.created.length, spent: d.spent.length, invalid: d.invalidTx.length, p2: d.p2 }); } catch (e) { console.log("ledgerDiff ERR", (e as Error).message); }
try { const i = indexBlock(block); console.log("index", { era: i.eraTag, txs: i.txs.length }); } catch (e) { console.log("index ERR", (e as Error).message); }
