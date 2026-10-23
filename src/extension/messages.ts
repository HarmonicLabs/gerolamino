/**
 * Message protocol between the popup, the background service worker and the offscreen document, and
 * the background's routing logic (`BackgroundHub`), kept free of `chrome.*` so it can be unit tested.
 *
 *   popup → background:      get-status | set-settings | submit-tx | wipe-store
 *   background → offscreen:  apply-settings | submit-tx | wipe-store
 *   offscreen → background:  offscreen-ready (answered with the settings) | stats | log
 *
 * Every message carries `to`, so a context ignores what is not addressed to it (runtime.sendMessage
 * reaches every extension page).
 */
import { loadSettings, saveSettings, type KeyValueArea, type Settings } from "./settings";

export type ToBackground =
    | { to: "background"; type: "get-status" }
    | { to: "background"; type: "set-settings"; settings: Partial<Settings> }
    | { to: "background"; type: "submit-tx"; cbor: string }
    | { to: "background"; type: "wipe-store" }
    | { to: "background"; type: "offscreen-ready" }
    | { to: "background"; type: "stats"; stats: unknown }
    | { to: "background"; type: "log"; lines: string[] };

export type ToOffscreen =
    | { to: "offscreen"; type: "apply-settings"; settings: Settings }
    | { to: "offscreen"; type: "submit-tx"; cbor: string }
    | { to: "offscreen"; type: "wipe-store" };

export type Reply<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export interface StatusReply {
    settings: Settings;
    /** Latest stats published by the offscreen document (null until it reports). */
    status: unknown;
    statusAgeMs: number | null;
    logs: string[];
}

export function isToBackground(m: unknown): m is ToBackground { return !!m && typeof m === "object" && (m as any).to === "background" && typeof (m as any).type === "string"; }
export function isToOffscreen(m: unknown): m is ToOffscreen { return !!m && typeof m === "object" && (m as any).to === "offscreen" && typeof (m as any).type === "string"; }

/** Signed transaction pasted as hex CBOR → bytes (whitespace ignored). */
export function parseTxHex(s: string): Uint8Array {
    const h = (s ?? "").replace(/\s+/g, "").replace(/^0x/i, "");
    if (!h.length) throw new Error("paste the signed transaction as hex CBOR");
    if (!/^([0-9a-f]{2})+$/i.test(h)) throw new Error("not hex: expected an even number of 0-9a-f characters");
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (out[0]! >> 5 !== 4) throw new Error("not a transaction: CBOR must start with an array");
    return out;
}

/** JSON-safe copy (bigints become strings, Uint8Arrays hex) for runtime messaging. */
export function toMessageSafe<T>(x: T): T {
    return JSON.parse(JSON.stringify(x, (_k, v) => typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("") : v));
}

export interface HubDeps {
    storage: KeyValueArea;
    sendToOffscreen(msg: ToOffscreen): Promise<unknown>;
    ensureOffscreen(): Promise<void>;
    now?: () => number;
    maxLogs?: number;
}

export class BackgroundHub {
    private status: unknown = null;
    private statusAt: number | null = null;
    private logs: string[] = [];
    constructor(private readonly deps: HubDeps) {}

    private now(): number { return (this.deps.now ?? Date.now)(); }

    async handle(msg: ToBackground): Promise<Reply<any>> {
        try {
            switch (msg.type) {
                case "get-status": {
                    void this.deps.ensureOffscreen().catch(() => {});
                    const reply: StatusReply = { settings: await loadSettings(this.deps.storage), status: this.status, statusAgeMs: this.statusAt == null ? null : this.now() - this.statusAt, logs: this.logs.slice(-50) };
                    return { ok: true, ...reply };
                }
                case "set-settings": {
                    const settings = await saveSettings(this.deps.storage, msg.settings ?? {});
                    await this.deps.ensureOffscreen();
                    await this.deps.sendToOffscreen({ to: "offscreen", type: "apply-settings", settings }).catch(() => {}); // a fresh offscreen document reads them on boot
                    return { ok: true, settings };
                }
                case "submit-tx":
                    await this.deps.ensureOffscreen();
                    return await this.forward({ to: "offscreen", type: "submit-tx", cbor: msg.cbor });
                case "wipe-store":
                    await this.deps.ensureOffscreen();
                    return await this.forward({ to: "offscreen", type: "wipe-store" });
                case "offscreen-ready":
                    return { ok: true, settings: await loadSettings(this.deps.storage) };
                case "stats":
                    this.status = msg.stats; this.statusAt = this.now();
                    return { ok: true };
                case "log":
                    this.logs.push(...(msg.lines ?? []));
                    if (this.logs.length > (this.deps.maxLogs ?? 200)) this.logs.splice(0, this.logs.length - (this.deps.maxLogs ?? 200));
                    return { ok: true };
                default:
                    return { ok: false, error: `unknown message ${(msg as any).type}` };
            }
        } catch (e) {
            return { ok: false, error: (e as Error).message ?? String(e) };
        }
    }

    private async forward(m: ToOffscreen): Promise<Reply<any>> {
        const r = await this.deps.sendToOffscreen(m);
        if (r && typeof r === "object" && "ok" in (r as any)) return r as Reply<any>;
        return { ok: false, error: "the node (offscreen document) did not answer" };
    }
}
