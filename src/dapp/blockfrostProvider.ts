/**
 * Gerolamino Blockfrost transport for dApps (pure, no Node builtins): a provider a page can hand to its SDK
 * so that Blockfrost GETs go through `window.cardano.gerolamino` (the in-browser gateway) instead of
 * `window.fetch`. When Gerolamino is connected to a Gerolamo peer, `query(path)` answers from the local
 * store first and otherwise over the N2N light query (request 8) from the peer's mini-Blockfrost; the
 * adapter returns the same {status, body} a fetch would have produced, so a Blockfrost SDK can keep its
 * response decoding unchanged.
 *
 * Not a wallet: no keys, no signing; submitTx forwards a wallet-signed transaction and returns its id.
 * Gerolamino rate-limits calls per site origin (60 per 10 s), so prefer paged GETs over bursts.
 */
export interface GerolaminoAnswer {
    status: number;
    body: unknown;
    source: "local" | "relay";
    peer?: string | null;
    proof?: unknown;
}

/** The CIP-30-shaped api returned by `window.cardano.gerolamino.enable()`. */
export interface GerolaminoApi {
    query(path: string): Promise<GerolaminoAnswer>;
    submitTx(txCborHex: string): Promise<string>;
    getNetworkId(): Promise<number>;
    getTip(): Promise<{ slot: number; height: number; hash: string; network: string; state: string; peerTip: unknown }>;
    isEnabled?(): Promise<boolean>;
}

export interface GerolaminoProvider {
    /** The CIP-30-shaped api object (post-enable). */
    readonly api: GerolaminoApi;
    /** Blockfrost GET: path with a leading "/", query string already encoded ("/addresses/{addr}/utxos?count=100&page=1"). */
    get(path: string, init?: { count?: number; page?: number; order?: "asc" | "desc" }): Promise<GerolaminoAnswer>;
    /** Blockfrost GET decoded: throws on non-200, otherwise returns the parsed body. */
    json<T = unknown>(path: string, init?: { count?: number; page?: number; order?: "asc" | "desc" }): Promise<T>;
    /** Paged GET across pages of `count` (default 100, Blockfrost's maximum), stops on a short page. */
    getAllPages<T = unknown>(path: string, opts?: { count?: number; maxPages?: number }): Promise<T[]>;
    /** Submit a wallet-signed transaction (hex CBOR); returns the tx id (CIP-30 submitTx semantics). */
    submitTx(txCborHex: string): Promise<string>;
}

export function hasGerolamino(win: any = typeof window === "undefined" ? undefined : window): boolean {
    const g = win?.cardano?.gerolamino;
    return !!g && typeof g.enable === "function" && typeof g.name === "string";
}

/** Enable once per site (the approval window) and return the api; throws the CIP-30 error on refusal. */
export async function enableGerolamino(win: any = typeof window === "undefined" ? undefined : window): Promise<GerolaminoApi> {
    const provider = win?.cardano?.gerolamino;
    if (!provider || typeof provider.enable !== "function") throw new Error("Gerolamino is not installed (window.cardano.gerolamino missing)");
    return (await provider.enable()) as GerolaminoApi;
}

const withQuery = (path: string, init?: { count?: number; page?: number; order?: "asc" | "desc" }): string => {
    if (!init) return path;
    const q = new URLSearchParams();
    if (init.count != null) q.set("count", String(init.count));
    if (init.page != null) q.set("page", String(init.page));
    if (init.order != null) q.set("order", init.order);
    const s = q.toString();
    if (!s) return path;
    return path + (path.includes("?") ? "&" : "?") + s;
};

export function gerolaminoProvider(api: GerolaminoApi): GerolaminoProvider {
    if (!api || typeof api.query !== "function") throw new Error("gerolaminoProvider: an enabled Gerolamino api is required");
    return {
        api,
        get: (path, init) => api.query(withQuery(path, init)),
        json: async (path, init) => {
            const a = await api.query(withQuery(path, init));
            if (a.status !== 200) throw new Error(`Gerolamino Blockfrost ${path}: ${a.status} ${JSON.stringify(a.body)}`);
            return a.body as never;
        },
        getAllPages: async (path, opts) => {
            const count = Math.min(Math.max(opts?.count ?? 100, 1), 100);
            const maxPages = opts?.maxPages ?? 50;
            const out: unknown[] = [];
            for (let page = 1; page <= maxPages; page++) {
                const a = await api.query(withQuery(path, { count, page }));
                if (a.status !== 200) throw new Error(`Gerolamino Blockfrost ${path} page ${page}: ${a.status} ${JSON.stringify(a.body)}`);
                if (!Array.isArray(a.body)) throw new Error(`Gerolamino Blockfrost ${path} page ${page}: not an array`);
                out.push(...a.body);
                if (a.body.length < count) break;
            }
            return out as never;
        },
        submitTx: (txCborHex) => api.submitTx(txCborHex),
    };
}

/** For SDKs that expect a fetch-shaped call: returns {status, body} with the Gerolamino answer, no window.fetch. */
export function gerolaminoFetch(api: GerolaminoApi) {
    const provider = gerolaminoProvider(api);
    return async (url: string): Promise<{ status: number; body: unknown; source: string }> => {
        const path = url.startsWith("http") ? new URL(url).pathname.replace(/^\/api\/v0/, "") : url;
        const a = await provider.get(path.startsWith("/") ? path : `/${path}`);
        return { status: a.status, body: a.body, source: a.source };
    };
}
