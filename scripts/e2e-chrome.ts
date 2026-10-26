/**
 * Browser end-to-end test: build dist/, launch Chrome for Testing headless with the unpacked extension,
 * drive it over the Chrome DevTools Protocol (own minimal client, scripts/lib/cdp.ts), and pass when the
 * extension's offscreen node verifies headers and writes blocks to OPFS within the time limit.
 *
 *   bun scripts/e2e-chrome.ts [--chrome <path>] [--start tip|chunk|mithril] [--timeout 180] [--relay ws://…] [--extra ws://…] [--trust]
 *                             [--no-build] [--keep-profile] [--screenshot <dir>]
 *
 * --extra adds an extra relay (cross-checked, phase 3). --trust waits for the trust checks: Mithril-certified stake and
 * no stake mismatch, the nonce confirmed by 5+ pools, the extra relay agreeing (with --extra), and a relayed
 * transaction answer proven by Mithril (--tx <hash>; default: a transaction from a block before this node's start
 * point, found through the peer, so the answer is relayed and not local).
 * --dapp serves examples/dapp-demo.html on localhost and drives window.cardano.gerolamino from it: enable() with
 * "Allow" clicked in the approval window, then network id, tip, trust and queries; a second site is denied.
 *
 * --screenshot <dir> saves popup.png (600 px wide, as the toolbar popup), panel.png (380 px, the side panel) and tab.png (the same page in a tab,
 * `popup.html?view=tab`) once the popup shows the running node.
 *
 * Steps: find the offscreen document target and attach; read its console; optionally switch the start mode
 * through the extension's own message path (popup → background → offscreen); wait for verified headers and
 * stored blocks; list the OPFS chunk files; close the offscreen document from the service worker and check
 * the background recreates it and the node resumes from the stored tip; render the popup and read its
 * status. Chrome is closed by its pid at the end.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cdp, type CdpEvent } from "./lib/cdp";

const root = resolve(import.meta.dir, "..");
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const chromeBin = arg("chrome", process.env.CHROME_BIN ?? "/tmp/claude-1000/-media-bakon-data-Dev-HarmonicLabs-gerolamo/238e2390-1daf-44f7-ab2b-59284d436f52/scratchpad/cft/chrome/linux-155.0.8059.84/chrome-linux64/chrome")!;
const startMode = arg("start", "chunk") as "tip" | "chunk" | "mithril";
const timeoutSec = Number(arg("timeout", startMode === "tip" ? "300" : startMode === "mithril" ? "900" : "120"));
const extra = arg("extra");
let trustTx = arg("tx");
const relay = arg("relay");
const dist = join(root, "dist");
const t0 = Date.now();
const log = (s: string) => console.log(`[e2e ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!process.argv.includes("--no-build")) {
    const b = Bun.spawnSync(["bun", "scripts/build.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (b.exitCode !== 0) throw new Error("build failed");
}

function freePort(): number {
    const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const p = s.port; s.stop(true); return p;
}

const port = freePort();
const profile = mkdtempSync(join(tmpdir(), "gerolamino-e2e-"));
const chrome = Bun.spawn([chromeBin,
    `--load-extension=${dist}`, `--disable-extensions-except=${dist}`,
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-dev-shm-usage",
    "about:blank",
], { stdout: "ignore", stderr: "pipe" });
log(`chrome pid ${chrome.pid}, CDP port ${port}, profile ${profile}`);

let cdp: Cdp | null = null;
let exitCode = 1;
const results: Record<string, unknown> = {};
try {
    // 1. browser endpoint
    let wsUrl = "";
    for (let i = 0; i < 100 && !wsUrl; i++) {
        try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(100); }
    }
    if (!wsUrl) throw new Error("Chrome did not open its DevTools endpoint");
    cdp = await Cdp.connect(wsUrl);
    await cdp.send("Target.setDiscoverTargets", { discover: true });

    const targets = async () => (await cdp!.send("Target.getTargets")).targetInfos as Array<{ targetId: string; type: string; url: string }>;
    const waitTarget = async (pred: (t: { type: string; url: string }) => boolean, what: string, ms = 30_000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { const t = (await targets()).find(pred); if (t) return t; await sleep(250); }
        throw new Error(`no ${what} target within ${ms / 1000} s; targets: ${JSON.stringify((await targets()).map((t) => `${t.type} ${t.url}`))}`);
    };
    const attach = async (targetId: string) => (await cdp!.send("Target.attachToTarget", { targetId, flatten: true })).sessionId as string;

    // 2. the offscreen document (created by the service worker on install)
    let off = await waitTarget((t) => t.url.endsWith("/offscreen.html"), "offscreen document");
    const extId = new URL(off.url).host;
    log(`extension ${extId}; offscreen target ${off.type} ${off.url}`);
    results.extensionId = extId;
    const consoleLines: string[] = [];
    cdp.on((e: CdpEvent) => {
        if (e.method === "Runtime.consoleAPICalled") {
            const line = (e.params.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ");
            consoleLines.push(line);
            if (line.startsWith("[gerolamino]")) log(`console: ${line.slice(13)}`);
        } else if (e.method === "Runtime.exceptionThrown") {
            const d = e.params.exceptionDetails; consoleLines.push(`EXCEPTION ${d?.exception?.description ?? d?.text}`); log(`exception: ${d?.exception?.description ?? d?.text}`);
        }
    });
    let offSession = await attach(off.targetId);
    await cdp.send("Runtime.enable", {}, offSession);
    for (let i = 0; i < 40; i++) { if (await cdp.evaluate(offSession, "typeof globalThis.__gerolamino === 'object'")) break; await sleep(250); }

    // 3. settings through the extension's own path (as the popup would)
    const settingsUpdate: Record<string, unknown> = {};
    if (startMode !== "tip") settingsUpdate.startMode = startMode;
    if (relay) settingsUpdate.relayUrl = relay;
    if (extra) settingsUpdate.extraRelays = [extra];
    if (Object.keys(settingsUpdate).length) {
        const r = await cdp.evaluate(offSession, `chrome.runtime.sendMessage({ to: "background", type: "set-settings", settings: ${JSON.stringify(settingsUpdate)} })`);
        log(`set-settings ${JSON.stringify(settingsUpdate)} → ${JSON.stringify(r)}`);
        if (!r?.ok) throw new Error("settings were not accepted");
        // start clean so the new start mode applies (a stored tip would otherwise win), through the popup's wipe path
        const w = await cdp.evaluate(offSession, `chrome.runtime.sendMessage({ to: "background", type: "wipe-store" })`);
        log(`wipe-store → ${JSON.stringify(w)}`);
        if (!w?.ok) throw new Error("wipe-store failed");
    }

    // 4. wait for verified headers and blocks in OPFS
    const status = async (session: string) => cdp!.evaluate<any>(session, "(async () => { await globalThis.__gerolamino.refreshOpfs(); return globalThis.__gerolamino.status(); })()");
    const want = startMode === "tip" ? 1 : 5;
    let s: any = null;
    const end = Date.now() + timeoutSec * 1000;
    let lastLine = "";
    while (Date.now() < end) {
        s = await status(offSession);
        const line = s ? `state=${s.state} v${s.version} headers=${s.headers} crypto=${s.cryptoOk}/${s.cryptoBad} bodies=${s.bodyOk}/${s.bodyBad} stored=${s.storedBlocks} opfs=${s.opfs?.bytes ?? "?"}B/${s.opfs?.files ?? "?"} files tip=${s.serverTip?.slot} ours=${s.lastSlot}` : "no status yet";
        if (line !== lastLine) { log(line); lastLine = line; }
        if (s && s.cryptoOk >= want && s.storedBlocks >= want && (s.opfs?.chunks ?? 0) > 0) break;
        if (s && (s.cryptoBad || s.linkBad || s.bodyBad || s.leaderBad)) break;
        await sleep(2000);
    }
    results.firstPhase = s && { state: s.state, version: s.version, headers: s.headers, cryptoOk: s.cryptoOk, cryptoBad: s.cryptoBad, leaderOk: s.leaderOk, leaderBad: s.leaderBad, bodyOk: s.bodyOk, bodyBad: s.bodyBad, storedBlocks: s.storedBlocks, opfs: s.opfs, serverTip: s.serverTip, lastSlot: s.lastSlot, cryptoMsPerHeader: s.cryptoOk ? Math.round(s.cryptoMs / s.cryptoOk) : null };
    const phase1 = !!s && s.cryptoOk >= want && s.storedBlocks >= want && (s.opfs?.chunks ?? 0) > 0 && !s.cryptoBad && !s.linkBad && !s.bodyBad && !s.leaderBad;
    if (!phase1) throw new Error(`headers/blocks did not verify and land in OPFS within ${timeoutSec} s`);
    const files = await cdp.evaluate<string[]>(offSession, `(async () => { let d = await navigator.storage.getDirectory(); for (const p of ["gerolamino", ${JSON.stringify(s.network)}, "immutable"]) d = await d.getDirectoryHandle(p); const out = []; for await (const [n, h] of d) { try { out.push(n + " " + (await h.getFile()).size); } catch { /* raced with the node rewriting it */ } } return out.sort(); })()`);
    log(`OPFS gerolamino/${s.network}/immutable: ${files.join(", ")}`);
    results.opfsFiles = files;
    const storedBefore = s.storedBlocks as number;
    const storedTip = s.storedTipSlot as number;

    // 5. close the offscreen document from the service worker: the background must recreate it, and the node must resume
    const sw = await waitTarget((t) => t.type === "service_worker" && t.url.includes(extId), "service worker");
    const swSession = await attach(sw.targetId);
    await cdp.send("Runtime.enable", {}, swSession);
    await cdp.evaluate(swSession, "chrome.offscreen.closeDocument()");
    log("offscreen document closed from the service worker; waiting for the background to recreate it");
    const oldId = off.targetId;
    off = await waitTarget((t) => t.url.endsWith("/offscreen.html") && (t as any).targetId !== oldId, "recreated offscreen document", 60_000);
    offSession = await attach(off.targetId);
    await cdp.send("Runtime.enable", {}, offSession);
    for (let i = 0; i < 40; i++) { if (await cdp.evaluate(offSession, "typeof globalThis.__gerolamino === 'object' && !!globalThis.__gerolamino.runner")) break; await sleep(250); }
    let s2: any = null;
    for (let i = 0; i < 30; i++) { s2 = await status(offSession); if (s2?.resumedFrom != null && s2.intersect) break; await sleep(1000); }
    log(`recreated: resumedFrom=${s2?.resumedFrom} storedBlocks=${s2?.storedBlocks} intersect=${s2?.intersect} state=${s2?.state}`);
    results.resume = { resumedFrom: s2?.resumedFrom, storedBlocksAfterReopen: s2?.storedBlocks, storedBefore, storedTip, intersect: s2?.intersect, state: s2?.state };
    const resumed = s2?.resumedFrom != null && s2.resumedFrom >= storedTip && s2.storedBlocks >= storedBefore;
    if (!resumed) throw new Error("the recreated offscreen document did not resume from the stored tip");

    // 6. the popup renders the status
    const tab = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
    const popSession = await attach(tab.targetId);
    await cdp.send("Runtime.enable", {}, popSession);
    let popup: any = null;
    for (let i = 0; i < 20; i++) {
        popup = await cdp.evaluate(popSession, `(() => { const t = (id) => document.getElementById(id)?.textContent ?? null; return { state: t("state"), conn: t("s-conn"), version: t("s-version"), headers: t("s-headers"), crypto: t("s-crypto"), opfs: t("s-opfs"), stored: t("s-stored"), relay: document.getElementById("relayUrl")?.value }; })()`);
        if (/^(syncing|at-tip)$/.test(popup?.state ?? "") && /^[1-9]/.test(popup?.opfs ?? "")) break;
        await sleep(500);
    }
    log(`popup: ${JSON.stringify(popup)}`);
    results.popup = popup;
    // the tx box answers (a malformed tx is refused with a message, through background → offscreen)
    const txReply = await cdp.evaluate(popSession, `chrome.runtime.sendMessage({ to: "background", type: "submit-tx", cbor: "zz" })`);
    log(`submit-tx (malformed) → ${JSON.stringify(txReply)}`);
    results.malformedTx = txReply;
    // local-first queries: the newest stored block is answered locally; the epoch needs the Gerolamo peer
    const ask = (path: string) => cdp!.evaluate<any>(popSession, `chrome.runtime.sendMessage({ to: "background", type: "query", path: ${JSON.stringify(path)} })`, 40_000);
    const qLocal = await ask("/blocks/latest"), qRelay = await ask("/epochs/latest");
    log(`query /blocks/latest → ${qLocal?.answer?.source} ${qLocal?.answer?.status}; /epochs/latest → ${qRelay?.answer?.source} ${qRelay?.answer?.status} (${JSON.stringify(qRelay?.answer?.body).slice(0, 80)})`);
    results.query = { local: qLocal?.answer?.source, relay: qRelay?.answer?.source, relayStatus: qRelay?.answer?.status };
    if (qLocal?.answer?.source !== "local") throw new Error("the newest stored block was not answered locally");
    const popupOk = !!popup?.headers && popup.headers !== "–" && /^[1-9]/.test(popup.opfs ?? "") && txReply?.ok === false;
    if (!popupOk) throw new Error("popup did not render the node status");

    // 7. the trust checks (phases 3 to 5)
    if (process.argv.includes("--trust")) {
        const tEnd = Date.now() + timeoutSec * 1000;
        let t: any = null, lastT = "";
        const trustOk = (x: any) => x?.trust?.stake?.source === "mithril" && !x.stakeMismatches && (x.trust?.nonce?.pools ?? 0) >= 5 && (!extra || x.peers?.[0]?.verdict === "agree");
        while (Date.now() < tEnd) {
            t = await status(offSession);
            const line = `stake ${t?.trust?.stake?.source}${t?.trust?.stake?.checking ? " (checking)" : ""} mismatches ${t?.stakeMismatches} | nonce pools ${t?.trust?.nonce?.pools} peers ${t?.trust?.nonce?.peersAgreeing}/${t?.trust?.nonce?.peersAsked} | ${(t?.peers ?? []).map((p: any) => `${p.url} ${p.verdict}`).join(", ") || "no extra relay"}`;
            if (line !== lastT) { log(line); lastT = line; }
            if (trustOk(t)) break;
            await sleep(5000);
        }
        results.trust = { stake: t?.trust?.stake, nonce: t?.trust?.nonce, peers: t?.trust?.peers, checks: t?.peers, stakeCertified: t?.stakeCertified, stakeMismatches: t?.stakeMismatches, leaderOk: t?.leaderOk, leaderBad: t?.leaderBad };
        if (!trustOk(t)) throw new Error("the trust checks did not complete");
        // a transaction this node did not store: from a block well before its start point, asked of the peer
        if (!trustTx) {
            const first = await ask("/blocks/latest");
            const height = Number(first?.answer?.body?.height ?? 0) - 3000;
            for (let h = height; h > height - 60 && !trustTx; h--) {
                const q = await ask(`/blocks/${h}/txs`);
                if (q?.answer?.source === "relay" && Array.isArray(q.answer.body) && q.answer.body.length) trustTx = String(q.answer.body[0]);
            }
            if (!trustTx) throw new Error("found no transaction before the start point to ask about");
            log(`transaction for the proof check: ${trustTx} (a block about 3000 below the tip)`);
        }
        let proof: any = null;
        while (Date.now() < tEnd) {
            const q = await ask(`/txs/${trustTx}`);
            proof = q?.answer?.proof;
            log(`query /txs/${trustTx.slice(0, 12)}… → ${q?.answer?.source} ${q?.answer?.status} proof ${proof?.status}: ${proof?.detail}`);
            if (q?.answer?.source === "local") throw new Error("the transaction was answered locally: pick one before the start point");
            if (proof && proof.status !== "unavailable") break;
            await sleep(15_000);
        }
        results.txProof = proof;
        if (proof?.status !== "certified") throw new Error("the relayed transaction answer was not proven by Mithril");
    }

    // 8. the dApp API (window.cardano.gerolamino) from a web page
    if (process.argv.includes("--dapp")) {
        const demo = Bun.file(join(import.meta.dir, "../examples/dapp-demo.html"));
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(demo, { headers: { "content-type": "text/html; charset=utf-8" } }) });
        try {
            const openSite = async (url: string) => {
                const t = await cdp!.send("Target.createTarget", { url });
                const sess = await attach(t.targetId);
                await cdp!.send("Runtime.enable", {}, sess);
                for (let i = 0; i < 40; i++) { if (await cdp!.evaluate(sess, "!!(window.cardano && window.cardano.gerolamino)")) break; await sleep(250); }
                return sess;
            };
            /** enable() on the page, answering the approval window with Allow or Deny. */
            const enableWith = async (sess: string, allow: boolean) => {
                await cdp!.evaluate(sess, "window.__enabled = window.cardano.gerolamino.enable().then(() => 'enabled', (e) => JSON.stringify(e)); true");
                const win = await waitTarget((t) => t.url.includes("/approve.html"), "approval window", 20_000);
                const ws = await attach((win as any).targetId);
                await cdp!.send("Runtime.enable", {}, ws);
                const shown = await cdp!.evaluate<string>(ws, "document.getElementById('origin').textContent");
                await cdp!.evaluate(ws, `document.getElementById(${JSON.stringify(allow ? "allow" : "deny")}).click(); true`);
                return { shown, result: await cdp!.evaluate<string>(sess, "window.__enabled", 30_000) };
            };
            const siteA = `http://127.0.0.1:${server.port}`, siteB = `http://localhost:${server.port}`;
            const a = await openSite(siteA + "/");
            const before = await cdp.evaluate<boolean>(a, "window.cardano.gerolamino.isEnabled()");
            const allowed = await enableWith(a, true);
            log(`dApp ${siteA}: isEnabled before ${before}; approval window showed ${allowed.shown}; enable() → ${allowed.result}`);
            const calls = await cdp.evaluate<any>(a, `(async () => {
                const api = await window.cardano.gerolamino.enable();
                const q = await api.query("/blocks/latest"), q2 = await api.query("/epochs/latest");
                return { net: await api.getNetworkId(), tip: await api.getTip(), trust: (await api.getTrust()).verdict.label,
                    latest: { source: q.source, status: q.status, height: q.body && q.body.height }, epoch: { source: q2.source, status: q2.status, epoch: q2.body && q2.body.epoch },
                    params: (await api.getProtocolParameters()).status, enabled: await window.cardano.gerolamino.isEnabled() };
            })()`, 60_000);
            log(`dApp calls: ${JSON.stringify(calls)}`);
            const b = await openSite(siteB + "/");
            const denied = await enableWith(b, false);
            const refusedQuery = await cdp.evaluate<string>(b, "window.cardano.gerolamino.isEnabled().then(String)");
            log(`dApp ${siteB}: approval window showed ${denied.shown}; Deny → ${denied.result}; isEnabled ${refusedQuery}`);
            const sites = await cdp.evaluate<any>(popSession, `chrome.runtime.sendMessage({ to: "background", type: "dapp-list" })`);
            results.dapp = { allowed, calls, denied, sites: sites?.sites?.map((s: any) => s.origin) };
            const ok = before === false && allowed.result === "enabled" && allowed.shown === siteA && calls?.net === 0 && calls?.tip?.slot > 0 && calls?.latest?.source === "local"
                && calls?.epoch?.source === "relay" && calls?.epoch?.status === 200 && calls?.enabled === true
                && /"code":-3/.test(denied.result) && refusedQuery === "false" && JSON.stringify(sites?.sites?.map((s: any) => s.origin)) === JSON.stringify([siteA]);
            if (!ok) throw new Error("the dApp API did not behave as expected");
        } finally { server.stop(true); }
    }

    const shots = arg("screenshot");
    if (shots) {
        mkdirSync(shots, { recursive: true });
        const sidePanel = await cdp.evaluate(popSession, "typeof chrome.sidePanel?.open");
        log(`side panel API: ${sidePanel}`);
        results.sidePanelApi = sidePanel;
        for (const [name, width, url] of [["popup", 600, "popup.html"], ["tab", 1100, "popup.html?view=tab"], ["panel", 380, "popup.html?view=panel"]] as const) {
            await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: false }, popSession);
            await cdp.send("Page.navigate", { url: `chrome-extension://${extId}/${url}` }, popSession);
            await sleep(3000);
            // show an answered query in the shot (relayed when the peer answers queries)
            await cdp.evaluate(popSession, `(() => { const i = document.getElementById("query-path"); i.value = ${JSON.stringify(process.argv.includes("--trust") && trustTx ? `/txs/${trustTx}` : "/epochs/latest")}; document.getElementById("query-form").requestSubmit(); })()`);
            await sleep(2500);
            const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, popSession);
            writeFileSync(join(shots, `${name}.png`), Buffer.from(shot.data, "base64"));
            log(`screenshot ${join(shots, `${name}.png`)}`);
        }
    }

    results.consoleErrors = consoleLines.filter((l) => /EXCEPTION|Uncaught/.test(l));
    exitCode = 0;
} catch (e) {
    log(`FAIL: ${(e as Error).message}`);
} finally {
    cdp?.close();
    try { process.kill(chrome.pid, "SIGTERM"); } catch { /* already gone */ }
    // a wrapper script (brave-browser) is not the browser: also end every process that uses this run's profile
    for (const d of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
        try { if (readFileSync(`/proc/${d}/cmdline`, "utf8").includes(`--user-data-dir=${profile}`)) process.kill(Number(d), "SIGTERM"); } catch { /* gone or not ours */ }
    }
    const exited = await Promise.race([chrome.exited.then(() => true), sleep(5000).then(() => false)]);
    if (!exited) { try { process.kill(chrome.pid, "SIGKILL"); } catch { /* gone */ } await chrome.exited; }
    log(`chrome (pid ${chrome.pid}) closed`);
    if (!process.argv.includes("--keep-profile")) rmSync(profile, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
console.log(exitCode === 0 ? "PASS" : "FAIL");
process.exit(exitCode);
