/**
 * Headless smoke run of the Gerolamino node core under Bun (the same code the extension's offscreen
 * document runs), against a relay's N2N-over-WebSocket endpoint, with an in-memory chunk store.
 *
 *   bun scripts/node-smoke.ts [--endpoint ws://192.168.1.173:3004/n2n] [--network preview] [--seconds 60]
 *                             [--start tip|chunk|mithril] [--json]
 *
 * `--start chunk` begins at the end of the relay's newest complete immutable chunk, so there is a backlog
 * of blocks to verify (a throughput figure); `tip` follows new blocks only (about one per 20 s on preview).
 * Passes when the handshake is accepted, at least one header verifies, nothing fails (links, bodies,
 * header crypto, leader checks) and every verified block landed in the store.
 */
import { MemorySink } from "../src/node/chunkWriter";
import { NodeRunner, type RunnerStats } from "../src/node/runner";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const endpoint = arg("endpoint", "ws://192.168.1.173:3004/n2n")!;
const network = arg("network", "preview") as "preview" | "preprod";
const seconds = Number(arg("seconds", "60"));
const startMode = arg("start", "tip") as "tip" | "chunk" | "mithril";
const quiet = process.argv.includes("--quiet");

const sink = new MemorySink();
const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
const runner = new NodeRunner({
    config: { relayUrl: endpoint, network, startMode },
    sinkFor: () => sink,
    log: (l) => { if (!quiet) console.log(`${ts()} ${l}`); },
});
let lastReport = 0;
const report = (s: RunnerStats) => {
    const el = (Date.now() - t0) / 1000;
    console.log(`${ts()} state=${s.state} headers=${s.headers} crypto ok/bad=${s.cryptoOk}/${s.cryptoBad} leader ok/bad=${s.leaderOk}/${s.leaderBad} bodies ok/bad=${s.bodyOk}/${s.bodyBad} stored=${s.storedBlocks} slot=${s.lastSlot} tip=${s.serverTip?.slot} (${(s.headers / el).toFixed(2)} headers/s)`);
};
const timer = setInterval(() => { const s = runner.stats(); if (s.headers !== lastReport) { lastReport = s.headers; report(s); } }, 5000);
runner.start();
await Bun.sleep(seconds * 1000);
clearInterval(timer);
await runner.stop();
const s = runner.stats();
const elapsed = (Date.now() - t0) / 1000;
const activeSec = s.firstHeaderAt && s.lastHeaderAt ? (s.lastHeaderAt - s.firstHeaderAt) / 1000 : 0;
const summary = {
    endpoint, network, startMode, seconds: Number(elapsed.toFixed(1)),
    version: s.version, lightQuery: s.lightQuery, intersect: s.intersect, serverTip: s.serverTip, connects: s.connects,
    headers: s.headers, linkOk: s.linkOk, linkBad: s.linkBad,
    cryptoOk: s.cryptoOk, cryptoBad: s.cryptoBad, cryptoSkipped: s.cryptoSkipped, leaderOk: s.leaderOk, leaderBad: s.leaderBad,
    blocksFetched: s.blocksFetched, bodyOk: s.bodyOk, bodyBad: s.bodyBad, rollbacks: s.rollbacks,
    storedBlocks: s.storedBlocks, storedBytes: s.storedBytes, storedChunks: s.storedChunks, sinkFiles: sink.files.size, sinkBytes: sink.bytes,
    headersPerSecWall: Number((s.headers / elapsed).toFixed(2)),
    headersPerSecWhileSyncing: activeSec > 0 ? Number(((s.headers - 1) / activeSec).toFixed(2)) : null,
    cryptoMsPerHeader: s.cryptoOk + s.cryptoBad ? Number((s.cryptoMs / (s.cryptoOk + s.cryptoBad)).toFixed(1)) : null,
    bytes: s.bytes, errors: s.errors,
};
console.log(JSON.stringify(summary, null, 2));
const ok = s.version != null && s.headers > 0 && s.cryptoOk > 0 && s.linkBad === 0 && s.bodyBad === 0 && s.cryptoBad === 0 && s.leaderBad === 0 && s.storedBlocks === s.bodyOk - s.rolledBackBlocks;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
