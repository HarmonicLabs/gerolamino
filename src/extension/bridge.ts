/**
 * Content script (isolated world, document_start): carries the page's `window.cardano.gerolamino` calls
 * (inpage.ts) to the background worker and the answers back. The background takes the site's origin from the
 * message sender, so a page cannot claim another site's approval.
 */
window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.gerolamino !== "call" || typeof m.id !== "number" || typeof m.method !== "string") return;
    const answer = (r: { ok: boolean; result?: unknown; error?: unknown }) =>
        window.postMessage({ gerolamino: "reply", id: m.id, ...r }, window.location.origin === "null" ? "*" : window.location.origin);
    try {
        chrome.runtime.sendMessage({ to: "background", type: "dapp", method: m.method, params: Array.isArray(m.params) ? m.params : [] })
            .then((r: any) => answer(r && typeof r === "object" && "ok" in r ? r : { ok: false, error: { code: -2, info: "no answer from Gerolamino" } }))
            .catch((e: Error) => answer({ ok: false, error: { code: -2, info: e.message } }));
    } catch (e) {
        // the extension was reloaded or removed: this page's bridge is orphaned
        answer({ ok: false, error: { code: -2, info: "Gerolamino is not available (reload the page)" } });
    }
});
