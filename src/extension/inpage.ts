/**
 * Runs in the page (content script, MAIN world, document_start): defines `window.cardano.gerolamino`, the dApp API
 * (dappApi.ts has the methods). Calls go to the bridge content script with window.postMessage and come back the same
 * way; nothing here is trusted by the extension, which takes the site's origin from the browser.
 */
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

(() => {
    const w = window as any;
    if (w.cardano?.gerolamino) return;
    const pending = new Map<number, Pending>();
    let next = 1;

    window.addEventListener("message", (ev) => {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || m.gerolamino !== "reply" || !pending.has(m.id)) return;
        const p = pending.get(m.id)!;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.result); else p.reject(m.error);
    });

    const call = (method: string, ...params: unknown[]): Promise<any> =>
        new Promise((resolve, reject) => {
            const id = next++;
            pending.set(id, { resolve, reject });
            window.postMessage({ gerolamino: "call", id, method, params }, window.location.origin === "null" ? "*" : window.location.origin);
        });

    const api = Object.freeze({
        getNetworkId: () => call("getNetworkId"),
        submitTx: (tx: string) => call("submitTx", tx),
        query: (path: string) => call("query", path),
        getTip: () => call("getTip"),
        getTrust: () => call("getTrust"),
        getUtxos: (address: string) => call("getUtxos", address),
        getProtocolParameters: () => call("getProtocolParameters"),
        getAccount: (stakeAddress: string) => call("getAccount", stakeAddress),
        getExtensions: () => Promise.resolve([]),
    });

    const provider = Object.freeze({
        name: "Gerolamino",
        apiVersion: "0.1.0",
        icon: "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff2d55"/><stop offset="1" stop-color="#ff9f0a"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="#0b0d12"/><circle cx="32" cy="32" r="22" fill="none" stroke="url(#g)" stroke-width="6"/></svg>`),
        /** Not a wallet: no keys, no signing. A full node API for pages (dappApi.ts). */
        isWallet: false,
        supportedExtensions: [],
        isEnabled: () => call("isEnabled"),
        enable: async () => { await call("enable"); return api; },
    });

    w.cardano = w.cardano ?? {};
    try { Object.defineProperty(w.cardano, "gerolamino", { value: provider, enumerable: true }); } catch { w.cardano.gerolamino = provider; }
})();
