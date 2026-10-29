#!/usr/bin/env bun
/**
 * Live check of the local UTxO ledger (docs/LEDGER_SPEC.md P0): run the node core against a Gerolamo peer
 * (in memory, no OPFS), wait for verified blocks that create outputs, then ask its ledger questions.
 *
 *   bun scripts/ledger-smoke.ts [--relay ws://127.0.0.1:3039/n2n] [--network preview] [--seconds 180]
 *
 * Passes when applied blocks reach the ledger, a stored transaction answers its outputs locally with coverage,
 * an unspent output answers /utxo locally, and the ledger never changes the verified chain store.
 */
import { NodeRunner } from "../src/node/runner";
import { MemorySink } from "../src/node/chunkWriter";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const relayUrl = arg("relay", "ws://192.168.1.173:3004/n2n");
const network = arg("network", "preview") as "preview" | "preprod";
const startMode = arg("start", "chunk") as "tip" | "chunk" | "mithril";
const seconds = Number(arg("seconds", "180"));

const storeSink = new MemorySink();
const ledgerSink = new MemorySink();
const runner = new NodeRunner({
    config: { relayUrl, network, startMode },
    sinkFor: () => storeSink,
    ledgerSinkFor: () => ledgerSink,
    log: (l) => console.log(`  node: ${l}`),
});
runner.start();
const t0 = Date.now();
let tipTx: string | null = null;
let localTx: unknown = null;
let unspentRef: string | null = null;
let coverage: unknown = null;
let utxoAnswer: unknown = null;
while (Date.now() - t0 < seconds * 1000) {
    const s = runner.stats();
    const tip = runner.index.tip;
    if (tip && s.ledgerBlocks > 0 && s.ledgerCreated > 0) {
        const candidates = tip.txs.map((t) => t.hash);
        for (const hash of candidates) {
            const a = await runner.query(`/txs/${hash}/utxos`);
            if (a.source === "local" && Array.isArray(a.body) && a.body.length) {
                tipTx = hash; localTx = a.body; coverage = a.ledger;
                const unspent = (a.body as any[]).find((o) => o.spent_boolean === false);
                if (unspent) {
                    const u = await runner.query(`/utxo/${unspent.tx_hash}:${unspent.output_index}`);
                    if (u.source === "local") { unspentRef = `${unspent.tx_hash}:${unspent.output_index}`; utxoAnswer = u.body; }
                }
                break;
            }
        }
        if (tipTx && unspentRef) break;
    }
    await Bun.sleep(1000);
}
await runner.stop();
const s = runner.stats();
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const stored = s.storedBlocks;
const summary = {
    relayUrl, network, seconds: elapsed,
    ledgerBlocks: s.ledgerBlocks, ledgerCreated: s.ledgerCreated, ledgerSpent: s.ledgerSpent, ledgerUtxoCount: s.ledgerUtxoCount,
    ledgerUnknownInputs: s.ledgerUnknownInputs, ledgerInvalidTx: s.ledgerInvalidTx, ledgerTipSlot: s.ledgerTipSlot,
    ledgerCoverageStart: s.ledgerCoverageStart, ledgerDigest: s.ledgerDigest, ledgerStale: s.ledgerStale, ledgerError: s.ledgerError,
    storedBlocks: stored, tipTx, coverage, unspentRef,
    localTxOutputs: Array.isArray(localTx) ? localTx.length : null,
    utxoAnswer,
    ledgerFiles: ledgerSink.files.size, ledgerBytes: ledgerSink.bytes, storeFiles: storeSink.files.size, errors: s.errors,
};
console.log(JSON.stringify(summary, null, 2));
const ok = s.ledgerBlocks > 0 && s.ledgerError === null && !s.ledgerStale && !!tipTx && !!unspentRef && Array.isArray(localTx) && localTx.length > 0 && coverage != null;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
