#!/usr/bin/env bun
/**
 * Live check of local-first queries: run the node against a Gerolamo peer (in memory, no OPFS), wait for a few
 * stored blocks, then ask questions it can answer itself and questions only the peer can answer.
 *
 *   bun scripts/query-smoke.ts [--relay ws://127.0.0.1:3039/n2n] [--network preview] [--blocks 3] [--address addr_test1…]
 */
import { NodeRunner } from "../src/node/runner";
import { MemorySink } from "../src/node/chunkWriter";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const relayUrl = arg("relay", "ws://127.0.0.1:3039/n2n");
const network = arg("network", "preview");
const want = Number(arg("blocks", "3"));
const address = arg("address", "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz");

const runner = new NodeRunner({ config: { relayUrl, network: network as "preview" | "preprod", startMode: "tip" }, sinkFor: () => new MemorySink(), log: (l) => console.log(`  node: ${l}`) });
runner.start();
const t0 = Date.now();
while (runner.index.size < want && Date.now() - t0 < 180_000) await new Promise((r) => setTimeout(r, 1000));
console.log(`\n${runner.index.size} block(s) stored and indexed after ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);

let failed = 0;
const tip = runner.index.tip;
const checks: Array<[string, string]> = [
    ["/blocks/latest", "local"],
    ...(tip ? [[`/blocks/${tip.hash}`, "local"], [`/blocks/${tip.height}/txs`, "local"]] as Array<[string, string]> : []),
    ...(tip?.txs[0] ? [[`/txs/${tip.txs[0].hash}`, "local"]] as Array<[string, string]> : []),
    ["/blocks/1000", "relay"],
    ["/epochs/latest", "relay"],
    [`/addresses/${address}`, "relay"],
    ["/pools?count=3", "relay"],
];
for (const [path, expect] of checks) {
    const a = await runner.query(path);
    const ok = a.source === expect && a.status === 200;
    if (!ok) failed++;
    const body = JSON.stringify(a.body);
    console.log(`${ok ? "OK  " : "FAIL"} ${a.source.padEnd(5)} ${a.status} ${String(a.ms).padStart(4)} ms  ${path}  ${body.slice(0, 110)}${body.length > 110 ? "…" : ""}`);
}
await runner.stop();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
