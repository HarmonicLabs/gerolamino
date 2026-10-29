/**
 * Extension settings, kept in `chrome.storage.local` under one key. Defaults: preview, the local Gerolamo
 * relay's WebSocket bearer (`ws://127.0.0.1:3004/n2n`; see `docs/RUN_LOCAL_GEROLAMO.md`), start at the relay's
 * tip (or the stored tip when resuming), no extra relays.
 */
export type NetworkName = "preview" | "preprod";
export type StartModeSetting = "tip" | "chunk" | "mithril";

export interface Settings {
    network: NetworkName;
    relayUrl: string;
    startMode: StartModeSetting;
    /** More relays to cross-check the main one against (headers only), at most MAX_EXTRA_RELAYS. */
    extraRelays: string[];
    /** Check the leader stake against Mithril's certified stake distribution (the IOG aggregator). */
    certifiedStake: boolean;
    /** Check relayed answers about a transaction with a Mithril proof that it is on the chain. */
    txProofs: boolean;
    /** Where a Mithril start gets the immutable file digests: the Gerolamo peer (fast) or the Mithril aggregator (direct). */
    mithrilDigests: "peer" | "aggregator";
}

export const MAX_EXTRA_RELAYS = 4;

export const SETTINGS_KEY = "gerolamino.settings";

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
    network: "preview",
    relayUrl: "ws://127.0.0.1:3004/n2n",
    startMode: "tip",
    extraRelays: [],
    certifiedStake: true,
    txProofs: true,
    mithrilDigests: "peer",
});

export const NETWORK_NAMES: readonly NetworkName[] = ["preview", "preprod"];
export const START_MODES: readonly StartModeSetting[] = ["tip", "chunk", "mithril"];

/** A relay URL must be ws:// or wss:// with a host. */
export function validRelayUrl(s: unknown): s is string {
    if (typeof s !== "string") return false;
    try { const u = new URL(s.trim()); return (u.protocol === "ws:" || u.protocol === "wss:") && !!u.hostname; } catch { return false; }
}

/** Valid, trimmed, distinct extra relays other than the main one, at most MAX_EXTRA_RELAYS. */
export function normalizeExtraRelays(raw: unknown, main: string): string[] {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
    const out: string[] = [];
    for (const u of list) {
        const t = typeof u === "string" ? u.trim() : "";
        if (validRelayUrl(t) && t !== main && !out.includes(t)) out.push(t);
    }
    return out.slice(0, MAX_EXTRA_RELAYS);
}

/** Fill in defaults and drop anything invalid (stored data may come from an older version). */
export function normalizeSettings(raw: unknown): Settings {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
    const relayUrl = validRelayUrl(r.relayUrl) ? (r.relayUrl as string).trim() : DEFAULT_SETTINGS.relayUrl;
    return {
        network: NETWORK_NAMES.includes(r.network as NetworkName) ? (r.network as NetworkName) : DEFAULT_SETTINGS.network,
        relayUrl,
        startMode: START_MODES.includes(r.startMode as StartModeSetting) ? (r.startMode as StartModeSetting) : DEFAULT_SETTINGS.startMode,
        extraRelays: normalizeExtraRelays(r.extraRelays, relayUrl),
        certifiedStake: typeof r.certifiedStake === "boolean" ? r.certifiedStake : DEFAULT_SETTINGS.certifiedStake,
        txProofs: typeof r.txProofs === "boolean" ? r.txProofs : DEFAULT_SETTINGS.txProofs,
        mithrilDigests: r.mithrilDigests === "aggregator" || r.mithrilDigests === "peer" ? r.mithrilDigests : DEFAULT_SETTINGS.mithrilDigests,
    };
}

/** Problems with a settings update from the popup (empty when it is valid). */
export function settingsErrors(raw: Partial<Record<keyof Settings, unknown>>): string[] {
    const errs: string[] = [];
    if (raw.relayUrl !== undefined && !validRelayUrl(raw.relayUrl)) errs.push("relay URL must be ws:// or wss://");
    if (raw.network !== undefined && !NETWORK_NAMES.includes(raw.network as NetworkName)) errs.push(`network must be one of ${NETWORK_NAMES.join(", ")}`);
    if (raw.startMode !== undefined && !START_MODES.includes(raw.startMode as StartModeSetting)) errs.push(`start mode must be one of ${START_MODES.join(", ")}`);
    if (raw.extraRelays !== undefined) {
        const list = Array.isArray(raw.extraRelays) ? raw.extraRelays : [raw.extraRelays];
        if (list.some((u) => !validRelayUrl(u))) errs.push("extra relays must be ws:// or wss:// URLs");
        else if (list.length > MAX_EXTRA_RELAYS) errs.push(`at most ${MAX_EXTRA_RELAYS} extra relays`);
    }
    return errs;
}

export function sameSettings(a: Settings, b: Settings): boolean {
    return a.network === b.network && a.relayUrl === b.relayUrl && a.startMode === b.startMode && a.extraRelays.join(" ") === b.extraRelays.join(" ") && a.certifiedStake === b.certifiedStake && a.txProofs === b.txProofs && a.mithrilDigests === b.mithrilDigests;
}

/** The storage area the settings live in (chrome.storage.local, or a fake in tests). */
export interface KeyValueArea {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

export async function loadSettings(area: KeyValueArea): Promise<Settings> {
    try { return normalizeSettings((await area.get(SETTINGS_KEY))[SETTINGS_KEY]); } catch { return { ...DEFAULT_SETTINGS }; }
}

export async function saveSettings(area: KeyValueArea, update: Partial<Settings>): Promise<Settings> {
    const errs = settingsErrors(update);
    if (errs.length) throw new Error(errs.join("; "));
    const next = normalizeSettings({ ...(await loadSettings(area)), ...update });
    await area.set({ [SETTINGS_KEY]: next });
    return next;
}
