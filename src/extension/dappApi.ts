/**
 * The dApp API (pure, unit tested): what a web page gets from `window.cardano.gerolamino`, shaped like CIP-30.
 * Gerolamino holds no keys, so it is not a wallet: it gives pages the chain through this node, local first and
 * otherwise from its Gerolamo peer, says how each answer was verified, and submits transactions a wallet signed.
 *
 *   window.cardano.gerolamino.enable()          → api (asks the user once per site)
 *   window.cardano.gerolamino.isEnabled()        → boolean
 *   api.getNetworkId()                           → 0 testnet, 1 mainnet (CIP-30)
 *   api.submitTx(txCborHex)                      → transaction id (CIP-30)
 *   api.query(path)                              → { status, body, source: "local" | "relay", proof? }  a Blockfrost GET
 *   api.getTip()                                 → { slot, height, hash, network, state }  this node's verified tip
 *   api.getTrust()                               → { verdict, rows }  the popup's Trust card as data
 *   api.getUtxos(address) / getProtocolParameters() / getAccount(stakeAddress)   shorthands for query()
 *
 * Errors follow CIP-30: { code, info } with APIError codes -1 InvalidRequest, -2 InternalError, -3 Refused, and
 * TxSendError 1 Refused, 2 Failure for submitTx. The site's origin comes from the browser (the message sender),
 * never from the page. Calls are rate limited per site.
 */
import type { KeyValueArea } from "./settings";
import { trustView } from "./trustView";

export const DAPP_API_VERSION = "0.1.0";
export const DAPPS_KEY = "gerolamino.dapps";
export const DAPP_RATE = 60;
export const DAPP_WINDOW_MS = 10_000;
const MAX_PATH = 1024;

export const APIError = { InvalidRequest: -1, InternalError: -2, Refused: -3 } as const;
export const TxSendError = { Refused: 1, Failure: 2 } as const;
export interface DappError { code: number; info: string }
export type DappReply = { ok: true; result: unknown } | { ok: false; error: DappError };

export const DAPP_METHODS = ["isEnabled", "enable", "getNetworkId", "submitTx", "query", "getTip", "getTrust", "getUtxos", "getProtocolParameters", "getAccount"] as const;
export type DappMethod = (typeof DAPP_METHODS)[number];

export interface ApprovedSite { origin: string; approvedAt: number }

/** Sites the user allowed, kept in chrome.storage.local. */
export class DappApprovals {
    constructor(private readonly area: KeyValueArea) {}
    async list(): Promise<ApprovedSite[]> {
        try {
            const raw = (await this.area.get(DAPPS_KEY))[DAPPS_KEY];
            return Array.isArray(raw) ? raw.filter((s): s is ApprovedSite => !!s && typeof s.origin === "string" && typeof s.approvedAt === "number") : [];
        } catch { return []; }
    }
    async has(origin: string): Promise<boolean> { return (await this.list()).some((s) => s.origin === origin); }
    async approve(origin: string, now = Date.now()): Promise<void> {
        const sites = (await this.list()).filter((s) => s.origin !== origin);
        await this.area.set({ [DAPPS_KEY]: [...sites, { origin, approvedAt: now }] });
    }
    async revoke(origin: string): Promise<void> {
        await this.area.set({ [DAPPS_KEY]: (await this.list()).filter((s) => s.origin !== origin) });
    }
}

export interface DappDeps {
    approvals: DappApprovals;
    /** Ask the user whether `origin` may use the node (an approval window); resolves false when denied or closed. */
    askUser(origin: string): Promise<boolean>;
    /** The node's latest stats (null while it has not reported). */
    status(): any;
    network(): Promise<string>;
    query(path: string): Promise<{ status: number; body: unknown; source: string; peer?: string; proof?: unknown }>;
    submitTx(cborHex: string): Promise<string>;
    now?: () => number;
}

const err = (code: number, info: string): DappReply => ({ ok: false, error: { code, info } });

/** A valid page origin: http(s) or file, as the browser reports it. */
export function validOrigin(origin: unknown): origin is string {
    return typeof origin === "string" && /^(https?:\/\/[^/\s]+|file:\/\/.*|null)$/.test(origin) && origin !== "null";
}

export class DappHub {
    private calls = new Map<string, number[]>();
    private asking = new Map<string, Promise<boolean>>();
    constructor(private readonly deps: DappDeps) {}

    private now(): number { return (this.deps.now ?? Date.now)(); }

    private limited(origin: string): boolean {
        const now = this.now();
        const times = (this.calls.get(origin) ?? []).filter((t) => now - t < DAPP_WINDOW_MS);
        if (times.length >= DAPP_RATE) { this.calls.set(origin, times); return true; }
        times.push(now);
        this.calls.set(origin, times);
        return false;
    }

    async handle(origin: unknown, method: unknown, params: unknown): Promise<DappReply> {
        if (!validOrigin(origin)) return err(APIError.Refused, "this page has no origin the node can approve");
        if (typeof method !== "string" || !(DAPP_METHODS as readonly string[]).includes(method)) return err(APIError.InvalidRequest, `unknown method ${String(method)}`);
        const args = Array.isArray(params) ? params : [];
        if (this.limited(origin)) return err(APIError.Refused, `at most ${DAPP_RATE} calls per ${DAPP_WINDOW_MS / 1000} s`);
        try {
            if (method === "isEnabled") return { ok: true, result: await this.deps.approvals.has(origin) };
            if (method === "enable") {
                if (await this.deps.approvals.has(origin)) return { ok: true, result: true };
                // one approval window per site at a time
                let asking = this.asking.get(origin);
                if (!asking) { asking = this.deps.askUser(origin).finally(() => this.asking.delete(origin)); this.asking.set(origin, asking); }
                if (!(await asking)) return err(APIError.Refused, "the user did not allow this site");
                await this.deps.approvals.approve(origin, this.now());
                return { ok: true, result: true };
            }
            if (!(await this.deps.approvals.has(origin))) return err(APIError.Refused, "call enable() first");
            switch (method as DappMethod) {
                case "getNetworkId": return { ok: true, result: (await this.deps.network()) === "mainnet" ? 1 : 0 };
                case "submitTx": {
                    const cbor = args[0];
                    if (typeof cbor !== "string" || !/^([0-9a-fA-F]{2})+$/.test(cbor)) return err(APIError.InvalidRequest, "submitTx(cbor): a signed transaction as hex CBOR");
                    try { return { ok: true, result: await this.deps.submitTx(cbor) }; }
                    catch (e) { return err(TxSendError.Failure, (e as Error).message); }
                }
                case "query": return this.query(args[0]);
                case "getUtxos": return typeof args[0] === "string" && /^[a-z0-9_]+$/i.test(args[0]) ? this.query(`/addresses/${args[0]}/utxos`) : err(APIError.InvalidRequest, "getUtxos(address): a bech32 address");
                case "getAccount": return typeof args[0] === "string" && /^[a-z0-9_]+$/i.test(args[0]) ? this.query(`/accounts/${args[0]}`) : err(APIError.InvalidRequest, "getAccount(stakeAddress): a bech32 stake address");
                case "getProtocolParameters": return this.query("/epochs/latest/parameters");
                case "getTip": {
                    const s = this.deps.status();
                    if (!s || s.lastSlot == null) return err(APIError.InternalError, "the node has no verified block yet");
                    return { ok: true, result: { slot: s.lastSlot, height: s.lastBlockNo, hash: s.lastHash, network: s.network, state: s.state, peerTip: s.serverTip ?? null } };
                }
                case "getTrust": {
                    const v = trustView(this.deps.status());
                    return { ok: true, result: { verdict: v.verdict, rows: v.rows.map(({ key, label, value, tone }) => ({ key, label, value, tone })) } };
                }
            }
            return err(APIError.InvalidRequest, `unknown method ${method}`);
        } catch (e) {
            return err(APIError.InternalError, (e as Error).message ?? String(e));
        }
    }

    private async query(path: unknown): Promise<DappReply> {
        if (typeof path !== "string" || !path.startsWith("/") || path.length > MAX_PATH || path.includes("..")) return err(APIError.InvalidRequest, "query(path): a Blockfrost path such as /blocks/latest");
        const a = await this.deps.query(path);
        return { ok: true, result: { status: a.status, body: a.body, source: a.source, peer: a.peer ?? null, proof: a.proof ?? null } };
    }
}
