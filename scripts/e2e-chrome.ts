/**
 * Browser end-to-end test: build dist/, launch Chrome for Testing headless with the unpacked extension,
 * drive it over the Chrome DevTools Protocol (own minimal client, scripts/lib/cdp.ts), and pass when the
 * extension's offscreen node verifies headers and writes blocks to OPFS within the time limit.
 *
 *   bun scripts/e2e-chrome.ts [--chrome <path>] [--start tip|chunk] [--timeout 180] [--relay ws://…] [--no-build] [--keep-profile] [--screenshot <dir>]
 *
 * --screenshot <dir> saves popup.png (440 px wide, as the toolbar popup) and tab.png (the same page in a tab,
 * `popup.html?view=tab`) once the popup shows the running node.
 *
 * Steps: find the offscreen document target and attach; read its console; optionally switch the start mode
 * through the extension's own message path (popup → background → offscreen); wait for verified headers and
 * stored blocks; list the OPFS chunk files; close the offscreen document from the service worker and check
 * the background recreates it and the node resumes from the stored tip; render the popup and read its
 * status. Chrome is closed by its pid at the end.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cdp, type CdpEvent } from "./lib/cdp";

const root = resolve(import.meta.dir, "..");
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const chromeBin = arg("chrome", process.env.CHROME_BIN ?? "/tmp/claude-1000/-media-bakon-data-Dev-HarmonicLabs-gerolamo/238e2390-1daf-44f7-ab2b-59284d436f52/scratchpad/cft/chrome/linux-155.0.8059.84/chrome-linux64/chrome")!;
const startMode = arg("start", "chunk") as "tip" | "chunk";
const timeoutSec = Number(arg("timeout", startMode === "tip" ? "300" : "120"));
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
    const settingsUpdate: Record<string, string> = {};
    if (startMode !== "tip") settingsUpdate.startMode = startMode;
    if (relay) settingsUpdate.relayUrl = relay;
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
    const popupOk = !!popup?.headers && popup.headers !== "–" && /^[1-9]/.test(popup.opfs ?? "") && txReply?.ok === false;
    if (!popupOk) throw new Error("popup did not render the node status");

    const shots = arg("screenshot");
    if (shots) {
        mkdirSync(shots, { recursive: true });
        for (const [name, width, url] of [["popup", 440, "popup.html"], ["tab", 1100, "popup.html?view=tab"]] as const) {
            await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: false }, popSession);
            await cdp.send("Page.navigate", { url: `chrome-extension://${extId}/${url}` }, popSession);
            await sleep(3000);
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
    const exited = await Promise.race([chrome.exited.then(() => true), sleep(5000).then(() => false)]);
    if (!exited) { try { process.kill(chrome.pid, "SIGKILL"); } catch { /* gone */ } await chrome.exited; }
    log(`chrome (pid ${chrome.pid}) closed`);
    if (!process.argv.includes("--keep-profile")) rmSync(profile, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
console.log(exitCode === 0 ? "PASS" : "FAIL");
process.exit(exitCode);
