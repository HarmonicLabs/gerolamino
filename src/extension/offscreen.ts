/**
 * Offscreen document: runs the Gerolamino node. Settings come from the background worker (an offscreen
 * document may only use `chrome.runtime`); verified blocks go to OPFS under `gerolamino/<network>/immutable`
 * as cardano-node chunk files; stats and log lines are published to the background once a second.
 * `globalThis.__gerolamino` exposes the runner for debugging (and the e2e test reads it over CDP).
 */
import { NodeRunner, type RunnerStats } from "../node/runner";
import { OpfsSink } from "../node/opfsSink";
import { LocalLedger } from "../node/ledgerStore";
import { snapshotFromTables, verifyMithrilTablesFiles } from "../node/mithrilTables";
import { isToOffscreen, parseTxHex, toMessageSafe, type Reply, type ToOffscreen } from "./messages";
import { DEFAULT_SETTINGS, normalizeSettings, sameSettings, type Settings } from "./settings";

const storePath = (network: string) => `gerolamino/${network}/immutable`;
const volatilePath = (network: string) => `gerolamino/${network}/volatile`;
const ledgerPath = (network: string) => `gerolamino/${network}/ledger`;
const snapshotSourcePath = (network: string) => `gerolamino/${network}/snapshot-source`;
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
        ledgerSinkFor: (network) => OpfsSink.available() ? new OpfsSink(ledgerPath(network), { workerUrl }) : undefined,
        log,
    });
}

function status(): (RunnerStats & { opfs: typeof opfs; settings: Settings }) | null {
    return runner ? { ...runner.stats(), opfs, settings } : null;
}

/** The OPFS subdirectories one network owns. */
const NETWORK_PARTS = ["immutable", "volatile", "ledger", "snapshot-source"] as const;

export interface NetworkStore {
    network: string;
    bytes: number;
    files: number;
    chunks: number;
    /** Which parts exist, so the popup can say what deleting it removes. */
    parts: string[];
    /** True for the network the node is running on. */
    active: boolean;
}

/**
 * Every network with an OPFS store in this profile, with its size. Switching between preview and preprod does
 * not delete the other one, so the popup has to show them separately rather than a single "wipe" button.
 */
async function listNetworkStores(): Promise<NetworkStore[]> {
    if (!OpfsSink.available()) return [];
    const root = await navigator.storage.getDirectory();
    let group: any;
    try { group = await root.getDirectoryHandle("gerolamino"); } catch { return []; }
    const out: NetworkStore[] = [];
    for await (const [name, handle] of group as any) {
        if (handle?.kind !== "directory") continue;
        const net = await group.getDirectoryHandle(name);
        let bytes = 0, files = 0, chunks = 0;
        const parts: string[] = [];
        for (const part of NETWORK_PARTS) {
            let dir: any;
            try { dir = await net.getDirectoryHandle(part); } catch { continue; }
            parts.push(part);
            for await (const [, fileHandle] of dir as any) {
                if (fileHandle?.kind !== "file") continue;
                try { const f = await fileHandle.getFile(); bytes += f.size; files++; if (f.name.endsWith(".chunk")) chunks++; } catch { /* raced with a delete */ }
            }
        }
        // `gerolamino/` also holds things that are not networks (e.g. mithril-certs); a real store has at
        // least one of the chain/ledger directories.
        if (!parts.length) continue;
        out.push({ network: name, bytes, files, chunks, parts, active: name === settings.network });
    }
    return out.sort((a, b) => a.network.localeCompare(b.network));
}

/**
 * Delete one network's whole OPFS store (chain, volatile, ledger, snapshot sources). Stops the node first when
 * the target is the active network, then restarts it from scratch; other networks are untouched.
 */
async function wipeNetworkStore(network: string): Promise<{ network: string; restarted: boolean }> {
    if (!/^[a-z0-9_-]{1,32}$/i.test(network)) throw new Error(`not a network name: ${network}`);
    const active = settings.network === network;
    const current = runner;
    if (active && current) await current.stop();
    for (const part of NETWORK_PARTS) await new OpfsSink(`gerolamino/${network}/${part}`, { workerUrl }).wipe();
    // the directory itself can still hold files the sink did not own
    try { const root = await navigator.storage.getDirectory(); const group = await root.getDirectoryHandle("gerolamino"); await group.removeEntry(network, { recursive: true }); } catch { /* already gone */ }
    log(`OPFS store for ${network} deleted (chain, volatile, ledger, snapshot sources)`);
    let restarted = false;
    if (active) { runner = makeRunner(settings); runner.start(); restarted = true; log(`node restarted on ${network} from scratch`); }
    await refreshOpfs();
    void publish();
    return { network, restarted };
}

async function refreshOpfs(): Promise<void> {
    try {
        if (!OpfsSink.available()) { opfs = null; return; }
        const imm = await new OpfsSink(storePath(settings.network), { workerUrl }).usage();
        const vol = await new OpfsSink(volatilePath(settings.network), { workerUrl }).usage();
        const led = await new OpfsSink(ledgerPath(settings.network), { workerUrl }).usage();
        opfs = { bytes: imm.bytes + vol.bytes + led.bytes, files: imm.files + vol.files + led.files, chunks: imm.chunks };
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
            case "import-snapshot": {
                const network = String(msg.network);
                if (network !== "preview" && network !== "preprod") throw new Error(`snapshot import network must be preview or preprod`);
                if (!Number.isInteger(msg.slot) || msg.slot <= 0) throw new Error("snapshot slot must be a positive integer");
                const source = new OpfsSink(snapshotSourcePath(network), { workerUrl });
                const tables = await source.read("tables");
                const meta = await source.read("meta");
                if (!tables || !meta) throw new Error("no tables/meta files in the extension's snapshot-source OPFS directory");
                const manifestBytes = await source.read("ancillary_manifest.json");
                const manifest = manifestBytes ? new TextDecoder().decode(manifestBytes) : null;
                if (manifest) {
                    const v = verifyMithrilTablesFiles(tables, meta, manifest, msg.slot, network);
                    if (!v.ok) throw new Error(`ancillary manifest verification failed: ${v.errors.join("; ")}`);
                    log(`snapshot manifest verified: signature ${v.signatureOk ? "ok" : "missing"}, tables ${v.tablesSha256?.slice(0, 12)}…`);
                }
                log(`snapshot import: ${tables.length} table byte(s), slot ${msg.slot}, network ${network}; building the UTxO base…`);
                const imported = snapshotFromTables(tables, meta, msg.slot, network);
                const current = runner;
                if (current) await current.stop();
                const ledger = new LocalLedger(new OpfsSink(ledgerPath(network), { workerUrl }), network);
                await ledger.installSnapshot(imported.snapshot, { verifyStateDigest: false });
                log(`snapshot installed: ${imported.decoded} UTxO from slot ${imported.snapshot.startSlot}; ledger resumes from it`);
                if (settings.network === network) settings = { ...settings, startMode: settings.startMode === "tip" ? "snapshot" : settings.startMode };
                await refreshOpfs();
                runner = makeRunner(settings); runner.start();
                return { ok: true, snapshotSlot: imported.snapshot.startSlot, utxos: imported.decoded };
            }
            case "query": {
                if (!runner) throw new Error("the node is not running");
                const answer = await runner.query(String(msg.path ?? ""));
                return { ok: true, answer: toMessageSafe(answer) };
            }
            case "storage-list":
                return { ok: true, stores: await listNetworkStores() };
            case "wipe-network": {
                const target = String((msg as any).network ?? "");
                return { ok: true, ...(await wipeNetworkStore(target)) };
            }
            case "wipe-store": {
                const r = runner;
                if (r) await r.stop();
                const sink = new OpfsSink(storePath(settings.network), { workerUrl });
                await sink.wipe();
                await new OpfsSink(volatilePath(settings.network), { workerUrl }).wipe();
                await new OpfsSink(ledgerPath(settings.network), { workerUrl }).wipe();
                log(`OPFS store for ${settings.network} wiped (immutable, volatile, ledger)`);
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
