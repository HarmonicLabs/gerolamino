#!/usr/bin/env bun
/**
 * Live check of the trust signals: follow a Gerolamo peer from its immutable tip (hours back, so the density window
 * fills quickly) and print freshness and density as the verified headers come in.
 *
 *   bun scripts/trust-smoke.ts [--relay ws://127.0.0.1:3039/n2n] [--network preview] [--timeout 300]
 */
import { NodeRunner } from "../src/node/runner";
import { MemorySink } from "../src/node/chunkWriter";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const relayUrl = arg("relay", "ws://127.0.0.1:3039/n2n");
const network = arg("network", "preview") as "preview" | "preprod";
const timeoutS = Number(arg("timeout", "300"));
const runner = new NodeRunner({ config: { relayUrl, network, startMode: "chunk" }, sinkFor: () => new MemorySink() });
runner.start();
const t0 = Date.now();
let last = "";
while (Date.now() - t0 < timeoutS * 1000) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = runner.stats();
    const f = s.trust.freshness, d = s.trust.density;
    const line = `freshness ${f?.status} (peer tip ${f?.lagSlots ?? "?"} slots behind the clock) | density ${d.status}: ${d.blocks} blocks in ${d.coveredSlots}/${d.windowSlots} slots, ratio ${d.ratio?.toFixed(2) ?? "?"}, ${d.pools} pools | crypto ${s.cryptoOk}/${s.cryptoBad}`;
    if (line !== last) { console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s  ${line}`); last = line; }
    if (d.status !== "insufficient" && s.state === "at-tip") break;
}
const s = runner.stats();
await runner.stop();
const ok = s.trust.freshness?.status === "fresh" && s.trust.density.status === "ok" && s.cryptoBad === 0;
console.log(ok ? "\nphase 1 live: OK (fresh, dense, all headers verified)" : "\nphase 1 live: NOT OK");
process.exit(ok ? 0 : 1);
