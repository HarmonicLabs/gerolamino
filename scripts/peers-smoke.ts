#!/usr/bin/env bun
/**
 * Live check of phase 3 (several peers, cross-checked):
 *   A. a main relay and a witness on the same chain: the witness ends up "agree" (settled headers match).
 *   B. a main relay that is down and a working witness: the runner switches the main peer to the witness.
 *
 *   bun scripts/peers-smoke.ts [--main ws://127.0.0.1:3039/n2n] [--witness ws://192.168.1.173:3004/n2n] [--timeout 300]
 */
import { NodeRunner } from "../src/node/runner";
import { MemorySink } from "../src/node/chunkWriter";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const main = arg("main", "ws://127.0.0.1:3039/n2n");
const witness = arg("witness", "ws://192.168.1.173:3004/n2n");
const timeoutS = Number(arg("timeout", "300"));

async function scenario(name: string, relayUrl: string, extra: string, done: (r: NodeRunner) => boolean): Promise<boolean> {
    console.log(`\n${name}: main ${relayUrl}, witness ${extra}`);
    const runner = new NodeRunner({ config: { relayUrl, network: "preview", startMode: "tip", extraRelays: [extra] }, sinkFor: () => new MemorySink(), log: (l) => { if (/switching|peer /.test(l)) console.log(`        log: ${l}`); } });
    runner.start();
    const t0 = Date.now();
    let last = "", ok = false;
    while (Date.now() - t0 < timeoutS * 1000) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = runner.stats();
        const line = `main ${s.endpoint} ${s.state} (${s.headers} headers) | ${s.peers.map((p) => `${p.url} ${p.verdict}: ${p.detail}`).join(" | ") || "no check yet"}`;
        if (line !== last) { console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s  ${line}`); last = line; }
        if (done(runner)) { ok = true; break; }
    }
    const s = runner.stats();
    console.log(`  trust.peers ${JSON.stringify(s.trust.peers)}`);
    if (s.failovers.length) console.log(`  failovers ${JSON.stringify(s.failovers.map(({ from, to, reason }) => ({ from, to, reason })))}`);
    await runner.stop();
    console.log(`  ${name}: ${ok ? "OK" : "NOT OK"}`);
    return ok;
}

const a = await scenario("A. agreeing peers", main, witness, (r) => { const s = r.stats(); return s.peers[0]?.verdict === "agree" && s.cryptoBad === 0; });
const b = await scenario("B. main peer down", "ws://127.0.0.1:3999/n2n", main, (r) => { const s = r.stats(); return s.endpoint === main && (s.state === "syncing" || s.state === "at-tip") && s.failovers.length === 1; });
console.log(`\nphase 3 live: ${a && b ? "OK" : "NOT OK"}`);
process.exit(a && b ? 0 : 1);
