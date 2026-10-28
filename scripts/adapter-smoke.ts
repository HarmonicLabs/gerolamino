/**
 * Live smoke: the gerolamino-blockfrost dApp transport against the real extension (Brave) and a Gerolamo peer.
 *
 *   bun scripts/adapter-smoke.ts
 *
 * Serves a page that imports dist/gerolamino-blockfrost.js, launches Brave headless with the unpacked extension,
 * approves the site in the approval window, waits for the node to follow the relay (getTip state syncing/at-tip),
 * then proves the Blockfrost path through Gerolamino: json("/blocks/latest") (local), get("/epochs/latest") (relay),
 * getAllPages("/addresses/{addr}/utxos") (paged), and get("/blocks/1000") (relay, not in the local store).
 * Requires a built dist/ and the extension's default relay to be live.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./lib/cdp";

const dist = join(import.meta.dir, "..", "dist");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s: string) => console.log(`[adapter ${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

const page = `<!doctype html><html><body><h1>adapter smoke</h1>
<script type="module">
  window.__adapter = (async () => {
    const m = await import("/gerolamino-blockfrost.js");
    if (!m.hasGerolamino()) return { has: false };
    const api = await m.enableGerolamino();
    const p = m.gerolaminoProvider(api);
    let ready = null;
    for (let i = 0; i < 180; i++) {
      try { const t = await api.getTip(); ready = t; if (t.state === "syncing" || t.state === "at-tip") break; } catch { /* connecting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    const tip = await p.json("/blocks/latest");
    const epoch = await p.get("/epochs/latest");
    const utxos = await p.getAllPages("/addresses/addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz/utxos", { count: 5 });
    return { has: true, apiVersion: window.cardano.gerolamino.apiVersion, readyState: ready?.state, tip: { height: tip?.height, slot: tip?.slot },
      epoch: { status: epoch.status, source: epoch.source, epoch: epoch.body?.epoch }, utxosCount: utxos.length, utxosFirst: utxos[0]?.tx_hash ?? null };
  })().catch((e) => ({ error: String(e) }));
</script></body></html>`;

const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/gerolamino-blockfrost.js") return new Response(Bun.file(join(dist, "gerolamino-blockfrost.js")));
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
});
const port = server.port;
const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const cdpPort = free.port; free.stop(true);
const profile = mkdtempSync(join(tmpdir(), "gerolamino-adapter-"));
const chromeBin = process.argv.includes("--chrome") ? process.argv[process.argv.indexOf("--chrome") + 1]! : "/usr/bin/brave-browser";
const chrome = Bun.spawn([chromeBin,
    `--load-extension=${dist}`, `--disable-extensions-except=${dist}`,
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-dev-shm-usage",
    "about:blank",
], { stdout: "ignore", stderr: "pipe" });
log(`browser pid ${chrome.pid}, CDP ${cdpPort}, page ${port}`);

let wsUrl = "";
for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(100); }
}
if (!wsUrl) { chrome.kill("SIGTERM"); throw new Error("no DevTools endpoint"); }
const cdp = await Cdp.connect(wsUrl);
await cdp.send("Target.setDiscoverTargets", { discover: true });
const targets = async () => (await cdp.send("Target.getTargets")).targetInfos as Array<{ targetId: string; type: string; url: string }>;
const waitTarget = async (pred: (t: { type: string; url: string }) => boolean, what: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const t = (await targets()).find(pred); if (t) return t; await sleep(250); }
    throw new Error(`no ${what}`);
};
const attach = async (targetId: string) => (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId as string;

try {
    const t = await cdp.send("Target.createTarget", { url: `http://127.0.0.1:${port}/` });
    const sess = await attach(t.targetId);
    await cdp.send("Runtime.enable", {}, sess);
    for (let i = 0; i < 40; i++) { if (await cdp.evaluate(sess, "!!(window.cardano && window.cardano.gerolamino)")) break; await sleep(250); }
    const found = await cdp.evaluate<boolean>(sess, "!!window.cardano?.gerolamino");
    log(`window.cardano.gerolamino ${found}`);
    if (!found) throw new Error("Gerolamino provider not injected");

    const win = await waitTarget((x) => x.url.includes("/approve.html"), "approval window", 20_000);
    const ws = await attach((win as any).targetId);
    await cdp.send("Runtime.enable", {}, ws);
    const shown = await cdp.evaluate<string>(ws, "document.getElementById('origin').textContent");
    await cdp.evaluate(ws, "document.getElementById('allow').click(); true");
    log(`approval window origin ${shown}; allow clicked`);

    const result = await cdp.evaluate<any>(sess, "window.__adapter", 120_000);
    console.log(JSON.stringify({ shown, result }, null, 2));

    const relay = await cdp.evaluate<any>(sess, `(async () => { const m = await import("/gerolamino-blockfrost.js"); const api = await m.enableGerolamino(); const p = m.gerolaminoProvider(api); const r = await p.get("/blocks/1000"); return { status: r.status, source: r.source }; })()`, 60_000);
    console.log(JSON.stringify({ relayProbe: relay }, null, 2));

    const ok = result?.has === true && result?.tip?.height > 0 && result?.epoch?.status === 200 && result?.epoch?.source === "relay"
        && result?.utxosCount > 0 && relay?.status === 200 && relay?.source === "relay";
    console.log(ok ? "PASS" : "FAIL");
    if (!ok) process.exitCode = 1;
} finally {
    chrome.kill("SIGTERM");
    server.stop(true);
}
