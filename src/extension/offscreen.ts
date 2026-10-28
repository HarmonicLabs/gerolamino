/**
 * Offscreen document: runs the Gerolamino node. Settings come from the background worker (an offscreen
 * document may only use `chrome.runtime`); verified blocks go to OPFS under `gerolamino/<network>/immutable`
 * as cardano-node chunk files; stats and log lines are published to the background once a second.
 * `globalThis.__gerolamino` exposes the runner for debugging (and the e2e test reads it over CDP).
 */
import { NodeRunner, type RunnerStats } from "../node/runner";
import { OpfsSink } from "../node/opfsSink";
import { isToOffscreen, parseTxHex, toMessageSafe, type Reply, type ToOffscreen } from "./messages";
import { DEFAULT_SETTINGS, normalizeSettings, sameSettings, type Settings } from "./settings";

const storePath = (network: string) => `gerolamino/${network}/immutable`;
const volatilePath = (network: string) => `gerolamino/${network}/volatile`;
const workerUrl = new URL("./opfsWorker.js", import.meta.url);
const pendingLogs: string[] = [];
let runner: NodeRunner | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS };
let opfs: { bytes: number; files: number; chunks: number } | null = null;

function log(line: string): void {
    const l = `${new Date().toISOString().slice(11, 19)} ${line}`;
    console.log(`[gerolamino] ${line}`);
    pendingLogs.push(l);
    if (pendingLogs.length > 500) pendingLogs.splice(0, pendingLogs.length - 500);
}

function makeRunner(s: Settings): NodeRunner {
    return new NodeRunner({
        config: { relayUrl: s.relayUrl, network: s.network, startMode: s.startMode, extraRelays: s.extraRelays, certifiedStake: s.certifiedStake, txProofs: s.txProofs, mithrilDigests: s.mithrilDigests },
        sinkFor: (network) => OpfsSink.available() ? new OpfsSink(storePath(network), { workerUrl }) : undefined,
        volatileSinkFor: (network) => OpfsSink.available() ? new OpfsSink(volatilePath(network), { workerUrl }) : undefined,
        log,
    });
}

function status(): (RunnerStats & { opfs: typeof opfs; settings: Settings }) | null {
    return runner ? { ...runner.stats(), opfs, settings } : null;
}

async function refreshOpfs(): Promise<void> {
    try {
        if (!OpfsSink.available()) { opfs = null; return; }
        const imm = await new OpfsSink(storePath(settings.network), { workerUrl }).usage();
        const vol = await new OpfsSink(volatilePath(settings.network), { workerUrl }).usage();
        opfs = { bytes: imm.bytes + vol.bytes, files: imm.files + vol.files, chunks: imm.chunks };
    } catch { /* keep the last figure */ }
}

async function publish(): Promise<void> {
    const lines = pendingLogs.splice(0);
    try {
        if (lines.length) await chrome.runtime.sendMessage({ to: "background", type: "log", lines });
        await chrome.runtime.sendMessage({ to: "background", type: "stats", stats: toMessageSafe(status()) });
    } catch { /* background restarting; next tick */ }
}

async function apply(next: Settings): Promise<void> {
    const prev = settings;
    settings = normalizeSettings(next);
    if (!runner) { runner = makeRunner(settings); runner.start(); log(`node started: ${settings.network} via ${settings.relayUrl} (start: ${settings.startMode})`); return; }
    if (sameSettings(prev, settings)) return;
    log(`settings changed: ${settings.network} via ${settings.relayUrl} (start: ${settings.startMode}, ${settings.extraRelays.length} extra relay(s)); restarting`);
    await runner.restart({ relayUrl: settings.relayUrl, network: settings.network, startMode: settings.startMode, extraRelays: settings.extraRelays, certifiedStake: settings.certifiedStake, txProofs: settings.txProofs, mithrilDigests: settings.mithrilDigests });
    await refreshOpfs();
}

async function handle(msg: ToOffscreen): Promise<Reply<any>> {
    try {
        switch (msg.type) {
            case "apply-settings": await apply(msg.settings); return { ok: true };
            case "submit-tx": {
                if (!runner) throw new Error("the node is not running");
                const id = runner.submitTx(parseTxHex(msg.cbor));
                log(`transaction ${id} queued for the relay`);
                return { ok: true, id };
            }
            case "query": {
                if (!runner) throw new Error("the node is not running");
                const answer = await runner.query(String(msg.path ?? ""));
                return { ok: true, answer: toMessageSafe(answer) };
            }
            case "wipe-store": {
                const r = runner;
                if (r) await r.stop();
                const sink = new OpfsSink(storePath(settings.network), { workerUrl });
                await sink.wipe();
                await new OpfsSink(volatilePath(settings.network), { workerUrl }).wipe();
                log(`OPFS store for ${settings.network} wiped`);
                await refreshOpfs();
                runner = makeRunner(settings); runner.start();
                void publish();
                return { ok: true };
            }
        }
    } catch (e) { return { ok: false, error: (e as Error).message }; }
    return { ok: false, error: "unknown message" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isToOffscreen(msg)) return false;
    handle(msg).then(sendResponse);
    return true;
});

/** Port to the background: lets it notice when this document goes away (and keeps it awake). */
function holdPort(): void {
    try {
        const port = chrome.runtime.connect({ name: "offscreen" });
        port.onDisconnect.addListener(() => setTimeout(holdPort, 1000));
    } catch { setTimeout(holdPort, 1000); }
}

async function boot(): Promise<void> {
    holdPort();
    let s: Settings = { ...DEFAULT_SETTINGS };
    for (let i = 0; i < 10; i++) {
        try { const r: any = await chrome.runtime.sendMessage({ to: "background", type: "offscreen-ready" }); if (r?.ok) { s = normalizeSettings(r.settings); break; } } catch { /* worker starting */ }
        await new Promise((r) => setTimeout(r, 500));
    }
    await apply(s);
    await refreshOpfs();
    void publish();
    setInterval(() => { void publish(); }, 1000);
    setInterval(() => { void refreshOpfs(); }, 2000);
}

(globalThis as any).__gerolamino = { get runner() { return runner; }, status: () => toMessageSafe(status()), refreshOpfs, settings: () => settings };
void boot();
