/**
 * Extension settings, kept in `chrome.storage.local` under one key. Defaults: preview, the Gerolamo
 * preview relay's WebSocket bearer, start at the relay's tip (or the stored tip when resuming).
 */
export type NetworkName = "preview" | "preprod";
export type StartModeSetting = "tip" | "chunk" | "mithril";

export interface Settings {
    network: NetworkName;
    relayUrl: string;
    startMode: StartModeSetting;
}

export const SETTINGS_KEY = "gerolamino.settings";

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
    network: "preview",
    relayUrl: "ws://192.168.1.173:3004/n2n",
    startMode: "tip",
});

export const NETWORK_NAMES: readonly NetworkName[] = ["preview", "preprod"];
export const START_MODES: readonly StartModeSetting[] = ["tip", "chunk", "mithril"];

/** A relay URL must be ws:// or wss:// with a host. */
export function validRelayUrl(s: unknown): s is string {
    if (typeof s !== "string") return false;
    try { const u = new URL(s.trim()); return (u.protocol === "ws:" || u.protocol === "wss:") && !!u.hostname; } catch { return false; }
}

/** Fill in defaults and drop anything invalid (stored data may come from an older version). */
export function normalizeSettings(raw: unknown): Settings {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
    return {
        network: NETWORK_NAMES.includes(r.network as NetworkName) ? (r.network as NetworkName) : DEFAULT_SETTINGS.network,
        relayUrl: validRelayUrl(r.relayUrl) ? (r.relayUrl as string).trim() : DEFAULT_SETTINGS.relayUrl,
        startMode: START_MODES.includes(r.startMode as StartModeSetting) ? (r.startMode as StartModeSetting) : DEFAULT_SETTINGS.startMode,
    };
}

/** Problems with a settings update from the popup (empty when it is valid). */
export function settingsErrors(raw: Partial<Record<keyof Settings, unknown>>): string[] {
    const errs: string[] = [];
    if (raw.relayUrl !== undefined && !validRelayUrl(raw.relayUrl)) errs.push("relay URL must be ws:// or wss://");
    if (raw.network !== undefined && !NETWORK_NAMES.includes(raw.network as NetworkName)) errs.push(`network must be one of ${NETWORK_NAMES.join(", ")}`);
    if (raw.startMode !== undefined && !START_MODES.includes(raw.startMode as StartModeSetting)) errs.push(`start mode must be one of ${START_MODES.join(", ")}`);
    return errs;
}

export function sameSettings(a: Settings, b: Settings): boolean {
    return a.network === b.network && a.relayUrl === b.relayUrl && a.startMode === b.startMode;
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
