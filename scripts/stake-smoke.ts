#!/usr/bin/env bun
/**
 * Live check of phase 4 (stake and nonce not taken on trust):
 *   - the leader stake comes from Mithril's certified stake distribution (chain checked to genesis), and the
 *     peer's figures agree with it (no mismatch);
 *   - the epoch nonce is confirmed by the VRF proofs of many distinct pools, and an extra peer gives the same nonce.
 *
 *   bun scripts/stake-smoke.ts [--main ws://127.0.0.1:3039/n2n] [--witness ws://192.168.1.173:3004/n2n] [--timeout 600]
 */
import { NodeRunner } from "../src/node/runner";
import { MemorySink } from "../src/node/chunkWriter";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const relayUrl = arg("main", "ws://127.0.0.1:3039/n2n");
const witness = arg("witness", "ws://192.168.1.173:3004/n2n");
const timeoutS = Number(arg("timeout", "600"));
const runner = new NodeRunner({
    config: { relayUrl, network: "preview", startMode: "chunk", extraRelays: [witness], certifiedStake: true },
    sinkFor: () => new MemorySink(),
    log: (l) => { if (/Mithril|MISMATCH|LEADER/.test(l)) console.log(`        log: ${l}`); },
});
runner.start();
const t0 = Date.now();
let last = "";
const done = () => {
    const s = runner.stats(), n = s.trust.nonce, st = s.trust.stake;
    return st?.source === "mithril" && s.stakeCertified >= 20 && s.stakeMismatches === 0 && s.leaderBad === 0 && (n?.pools ?? 0) >= 5 && (n?.peersAgreeing ?? 0) >= 2;
};
while (Date.now() - t0 < timeoutS * 1000) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = runner.stats(), n = s.trust.nonce, st = s.trust.stake;
    const line = `headers ${s.headers} leader ok/bad ${s.leaderOk}/${s.leaderBad} | stake ${st?.source}${st?.checking ? " (checking)" : ""} certified checks ${s.stakeCertified} mismatches ${s.stakeMismatches} | nonce epoch ${n?.epoch} pools ${n?.pools} peers ${n?.peersAgreeing}/${n?.peersAsked}`;
    if (line !== last) { console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s  ${line}`); last = line; }
    if (done()) break;
}
const ok = done();
const s = runner.stats();
console.log(`  trust.stake ${JSON.stringify(s.trust.stake)}\n  trust.nonce ${JSON.stringify(s.trust.nonce)}`);
await runner.stop();
console.log(`\nphase 4 live: ${ok ? "OK" : "NOT OK"}`);
process.exit(ok ? 0 : 1);
