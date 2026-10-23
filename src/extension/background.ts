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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isToBackground(msg)) return false;
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
