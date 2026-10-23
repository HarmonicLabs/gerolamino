#!/usr/bin/env bun
/**
 * Live check of phase 5 (relayed answers proven by Mithril): ask the Gerolamo peer about transactions this node
 * has not stored, and check each answer against a Mithril CardanoTransactions proof.
 *   - a real transaction: "certified", in the block range of its block_height;
 *   - a transaction hash the peer does not know: 404 from the peer, nothing to prove.
 * The first proof walks the certificate chain to genesis (minutes, no cache under Bun); the query is retried until done.
 *
 *   bun scripts/txproof-smoke.ts [--main ws://127.0.0.1:3039/n2n] [--tx <hash>] [--timeout 600]
 */
import { NodeRunner } from "../src/node/runner";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const relayUrl = arg("main", "ws://127.0.0.1:3039/n2n");
const tx = arg("tx", "bbe0d151bdfcf3ba4f6008ddfaed9030fae26861dedb108c258c335803727640");
const timeoutS = Number(arg("timeout", "600"));
const runner = new NodeRunner({ config: { relayUrl, network: "preview", startMode: "tip", txProofs: true }, log: (l) => { if (/Mithril/.test(l)) console.log(`        log: ${l}`); } });
runner.start();
while (!runner.stats().lightQuery) await new Promise((r) => setTimeout(r, 500));
const t0 = Date.now();
let ok = false;
while (Date.now() - t0 < timeoutS * 1000) {
    const a = await runner.query(`/txs/${tx}`);
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s  /txs/${tx.slice(0, 12)}… ${a.source} ${a.status} block ${(a.body as any)?.block_height} | proof ${a.proof?.status}: ${a.proof?.detail}`);
    if (a.proof && a.proof.status !== "unavailable") { ok = a.proof.status === "certified"; break; }
    await new Promise((r) => setTimeout(r, 30_000));
}
const fake = await runner.query(`/txs/${"0".repeat(64)}`);
console.log(`  /txs/000…000 ${fake.source} ${fake.status} | proof ${fake.proof?.status ?? "none (not a 200 answer)"}`);
ok &&= fake.status === 404 && !fake.proof;
await runner.stop();
console.log(`\nphase 5 tx proofs live: ${ok ? "OK" : "NOT OK"}`);
process.exit(ok ? 0 : 1);
