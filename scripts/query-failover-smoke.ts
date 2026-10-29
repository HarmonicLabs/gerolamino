/**
 * Live check of peer-backed Blockfrost queries: the main relay is dead, an extra Gerolamo peer answers.
 *
 *   bun scripts/query-failover-smoke.ts
 *
 * Starts a runner against ws://127.0.0.1:9999/n2n (nothing there) with the .173 Gerolamo peer as an extra
 * relay, waits for the watcher to connect, then proves /addresses/{addr}/utxos, /epochs/latest and /blocks/1000
 * all answer 200 from the extra peer (the answer names it).
 */
import { MemorySink } from "../src/node/chunkWriter";
import { NodeRunner } from "../src/node/runner";

const addr = "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz";
const runner = new NodeRunner({
    config: { relayUrl: "ws://127.0.0.1:9999/n2n", network: "preview", startMode: "tip", extraRelays: ["ws://192.168.1.173:3004/n2n"] },
    sinkFor: () => new MemorySink(),
    log: (l) => console.log(`  node: ${l}`),
});
runner.start();
await Bun.sleep(8000);
const a1 = await runner.query(`/addresses/${addr}/utxos`);
const a2 = await runner.query("/epochs/latest");
const a3 = await runner.query("/blocks/1000");
console.log(JSON.stringify({ probe: "addresses/utxos", status: a1.status, source: a1.source, peer: a1.peer, bodyLen: JSON.stringify(a1.body).length }, null, 2));
console.log(JSON.stringify({ probe: "epochs/latest", status: a2.status, source: a2.source, peer: a2.peer, epoch: (a2.body as any)?.epoch }, null, 2));
console.log(JSON.stringify({ probe: "blocks/1000", status: a3.status, source: a3.source, peer: a3.peer, height: (a3.body as any)?.height }, null, 2));
await runner.stop();
const ok = a1.status === 200 && a1.peer === "ws://192.168.1.173:3004/n2n" && a2.status === 200 && a3.status === 200;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
