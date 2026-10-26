/**
 * Background service worker. It does not run the node (a service worker is stopped when idle and has
 * no OPFS writable streams): it keeps the offscreen document that does alive, and relays messages
 * between the popup and that document.
 *
 * - The offscreen document is created on install, on browser start-up, when this worker starts, when
 *   the popup asks for anything, and every 30 s by an alarm if it is missing.
 * - The offscreen document holds a port to this worker; when that port drops because the document
 *   closed, the document is recreated (when it drops because this worker restarted, the document
 *   reconnects by itself).
 */
import { BackgroundHub, isToBackground, type ToOffscreen } from "./messages";
import { DappApprovals, DappHub } from "./dappApi";
import { loadSettings } from "./settings";

const OFFSCREEN_PATH = "offscreen.html";
const ALARM = "gerolamino-ensure-offscreen";

let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
    const url = chrome.runtime.getURL(OFFSCREEN_PATH);
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    return contexts.length > 0;
}

export async function ensureOffscreen(): Promise<void> {
    if (await hasOffscreen()) return;
    if (!creating) {
        creating = chrome.offscreen.createDocument({
            url: OFFSCREEN_PATH,
            reasons: ["WORKERS"],
            justification: "Runs the Gerolamino Cardano node: a long-lived WebSocket to the relay, header verification, and chain storage in OPFS (with a worker for synchronous OPFS writes).",
        }).catch((e: Error) => { if (!/single offscreen|already/i.test(e.message)) throw e; })
          .finally(() => { creating = null; });
    }
    await creating;
}

const hub = new BackgroundHub({
    storage: chrome.storage.local,
    ensureOffscreen,
    sendToOffscreen: (m: ToOffscreen) => chrome.runtime.sendMessage(m),
});

// ---- the dApp API: window.cardano.gerolamino calls from web pages (dappApi.ts) ----
const approvals = new DappApprovals(chrome.storage.local);
const waitingApproval = new Map<string, (approved: boolean) => void>();
const APPROVAL_TIMEOUT_MS = 120_000;

/** Open the approval window for a site and wait for the user's answer (closing the window denies). */
async function askUser(origin: string): Promise<boolean> {
    const requestId = crypto.randomUUID();
    const answered = new Promise<boolean>((resolve) => {
        waitingApproval.set(requestId, resolve);
        setTimeout(() => { if (waitingApproval.delete(requestId)) resolve(false); }, APPROVAL_TIMEOUT_MS);
    });
    const win = await chrome.windows.create({ url: chrome.runtime.getURL(`approve.html?origin=${encodeURIComponent(origin)}&id=${requestId}`), type: "popup", width: 440, height: 560, focused: true });
    const onRemoved = (id: number) => { if (id === win?.id) { const r = waitingApproval.get(requestId); if (r) { waitingApproval.delete(requestId); r(false); } } };
    chrome.windows.onRemoved.addListener(onRemoved);
    try { return await answered; } finally { chrome.windows.onRemoved.removeListener(onRemoved); }
}

async function forward(m: ToOffscreen): Promise<any> {
    await ensureOffscreen();
    const r: any = await chrome.runtime.sendMessage(m);
    if (!r?.ok) throw new Error(r?.error ?? "the node did not answer");
    return r;
}

const dapps = new DappHub({
    approvals,
    askUser,
    status: () => hub.latestStatus(),
    network: async () => (await loadSettings(chrome.storage.local)).network,
    query: async (path) => (await forward({ to: "offscreen", type: "query", path })).answer,
    submitTx: async (cbor) => String((await forward({ to: "offscreen", type: "submit-tx", cbor })).id),
});

const EXTENSION_ORIGIN = chrome.runtime.getURL("");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isToBackground(msg)) return false;
    // web pages (content scripts in tabs) may only make dApp calls; everything else comes from the extension's own pages
    const fromWebPage = !!sender.tab && !String(sender.url ?? "").startsWith(EXTENSION_ORIGIN);
    if (fromWebPage && msg.type !== "dapp") return false;
    if (msg.type === "dapp") {
        // the site is who the browser says sent the message, from a tab (a content script), never what the page claims
        const origin = sender.tab ? (sender.origin ?? (sender.url ? new URL(sender.url).origin : null)) : null;
        dapps.handle(origin, msg.method, msg.params).then(sendResponse, (e: Error) => sendResponse({ ok: false, error: { code: -2, info: e.message } }));
        return true;
    }
    if (msg.type === "dapp-approval") {
        // only the extension's own approval page may answer
        if (sender.id !== chrome.runtime.id || !String(sender.url ?? "").startsWith(chrome.runtime.getURL("approve.html"))) return false;
        const r = waitingApproval.get(msg.requestId);
        if (r) { waitingApproval.delete(msg.requestId); r(!!msg.approved); }
        sendResponse({ ok: true });
        return false;
    }
    if (msg.type === "dapp-list") { approvals.list().then((sites) => sendResponse({ ok: true, sites })); return true; }
    if (msg.type === "dapp-revoke") { approvals.revoke(msg.origin).then(() => sendResponse({ ok: true })); return true; }
    hub.handle(msg).then(sendResponse, (e: Error) => sendResponse({ ok: false, error: e.message }));
    return true; // async response
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "offscreen") return;
    port.onDisconnect.addListener(() => { setTimeout(() => { ensureOffscreen().catch((e) => console.warn("[gerolamino] recreate offscreen:", e)); }, 500); });
});

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) ensureOffscreen().catch((e) => console.warn("[gerolamino] ensure offscreen:", e)); });
chrome.runtime.onInstalled.addListener(() => { ensureOffscreen().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { ensureOffscreen().catch(() => {}); });

chrome.alarms.get(ALARM).then((a) => { if (!a) return chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); }).catch(() => {});
ensureOffscreen().catch((e) => console.warn("[gerolamino] ensure offscreen:", e));
