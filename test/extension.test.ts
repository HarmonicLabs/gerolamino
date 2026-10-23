import { describe, expect, test } from "bun:test";
import { BackgroundHub, isToBackground, isToOffscreen, parseTxHex, toMessageSafe, type ToOffscreen } from "../src/extension/messages";
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, normalizeSettings, saveSettings, settingsErrors, validRelayUrl, type KeyValueArea } from "../src/extension/settings";
import { connectionLabel, epochProgress, fmtBytes, fmtNum, fmtSlotsBehind, fmtSlotsShort, intersectSlot, stateTone, syncPercent } from "../src/extension/format";

function memoryArea(init: Record<string, unknown> = {}): KeyValueArea & { data: Record<string, unknown> } {
    const data = { ...init };
    return { data, async get(k) { return k in data ? { [k]: structuredClone(data[k]) } : {}; }, async set(items) { Object.assign(data, structuredClone(items)); } };
}

describe("settings", () => {
    test("defaults: preview, the preview relay's WebSocket bearer, tip", () => {
        expect(DEFAULT_SETTINGS).toEqual({ network: "preview", relayUrl: "ws://192.168.1.173:3004/n2n", startMode: "tip", extraRelays: [], certifiedStake: true, txProofs: true });
    });
    test("normalize fills defaults and drops invalid values", () => {
        expect(normalizeSettings(undefined)).toEqual({ ...DEFAULT_SETTINGS });
        expect(normalizeSettings({ network: "mainnet", relayUrl: "http://x", startMode: "origin" })).toEqual({ ...DEFAULT_SETTINGS });
        expect(normalizeSettings({ network: "preprod", relayUrl: " wss://relay.example/n2n ", startMode: "mithril" })).toEqual({ network: "preprod", relayUrl: "wss://relay.example/n2n", startMode: "mithril", extraRelays: [], certifiedStake: true, txProofs: true });
    });
    test("relay URLs must be ws:// or wss://", () => {
        expect(validRelayUrl("ws://127.0.0.1:3003")).toBe(true);
        expect(validRelayUrl("wss://relay.example/n2n")).toBe(true);
        expect(validRelayUrl("https://relay.example")).toBe(false);
        expect(validRelayUrl("relay:3004")).toBe(false);
        expect(settingsErrors({ relayUrl: "http://x", network: "x" as any })).toHaveLength(2);
    });
    test("save merges, validates and persists; load reads it back", async () => {
        const area = memoryArea();
        expect(await loadSettings(area)).toEqual({ ...DEFAULT_SETTINGS });
        await saveSettings(area, { network: "preprod" });
        expect(area.data[SETTINGS_KEY]).toEqual({ ...DEFAULT_SETTINGS, network: "preprod" });
        await expect(saveSettings(area, { relayUrl: "ftp://nope" })).rejects.toThrow(/ws:\/\//);
        expect((await loadSettings(area)).network).toBe("preprod");
    });
});

describe("messages", () => {
    test("addressing", () => {
        expect(isToBackground({ to: "background", type: "get-status" })).toBe(true);
        expect(isToBackground({ to: "offscreen", type: "submit-tx" })).toBe(false);
        expect(isToOffscreen({ to: "offscreen", type: "wipe-store" })).toBe(true);
        expect(isToOffscreen(null)).toBe(false);
    });
    test("parseTxHex accepts hex CBOR arrays only", () => {
        expect(parseTxHex(" 84 a0\n a0 f5 f6 ")).toEqual(new Uint8Array([0x84, 0xa0, 0xa0, 0xf5, 0xf6]));
        expect(parseTxHex("0x84a0a0f5f6").length).toBe(5);
        expect(() => parseTxHex("")).toThrow(/paste/);
        expect(() => parseTxHex("84a")).toThrow(/hex/);
        expect(() => parseTxHex("a0")).toThrow(/array/);
    });
    test("toMessageSafe turns bigints and bytes into strings", () => {
        expect(toMessageSafe({ a: 1n, b: new Uint8Array([1, 255]), c: [2n] })).toEqual({ a: "1", b: "01ff", c: ["2"] } as any);
    });
});

describe("background hub", () => {
    function hub(offscreenReply: (m: ToOffscreen) => unknown = () => ({ ok: true })) {
        const area = memoryArea();
        const sent: ToOffscreen[] = [];
        let ensured = 0, now = 1_000;
        const h = new BackgroundHub({ storage: area, ensureOffscreen: async () => { ensured++; }, sendToOffscreen: async (m) => { sent.push(m); return offscreenReply(m); }, now: () => now, maxLogs: 3 });
        return { h, area, sent, ensured: () => ensured, tick: (ms: number) => { now += ms; } };
    }
    test("offscreen-ready answers with the stored settings; stats and logs are cached for the popup", async () => {
        const { h, tick } = hub();
        expect(await h.handle({ to: "background", type: "offscreen-ready" })).toEqual({ ok: true, settings: { ...DEFAULT_SETTINGS } });
        await h.handle({ to: "background", type: "stats", stats: { headers: 5 } });
        await h.handle({ to: "background", type: "log", lines: ["a", "b", "c", "d"] });
        tick(1500);
        const r: any = await h.handle({ to: "background", type: "get-status" });
        expect(r.ok).toBe(true);
        expect(r.status).toEqual({ headers: 5 });
        expect(r.statusAgeMs).toBe(1500);
        expect(r.logs).toEqual(["b", "c", "d"]);
    });
    test("set-settings saves, makes sure the offscreen document exists and forwards apply-settings", async () => {
        const { h, area, sent, ensured } = hub();
        const r: any = await h.handle({ to: "background", type: "set-settings", settings: { network: "preprod", relayUrl: "wss://r.example/n2n" } });
        expect(r.ok).toBe(true);
        expect(area.data[SETTINGS_KEY]).toEqual({ network: "preprod", relayUrl: "wss://r.example/n2n", startMode: "tip", extraRelays: [], certifiedStake: true, txProofs: true });
        expect(sent).toEqual([{ to: "offscreen", type: "apply-settings", settings: { network: "preprod", relayUrl: "wss://r.example/n2n", startMode: "tip", extraRelays: [], certifiedStake: true, txProofs: true } }]);
        expect(ensured()).toBe(1);
        expect(await h.handle({ to: "background", type: "set-settings", settings: { relayUrl: "http://x" } })).toMatchObject({ ok: false });
    });
    test("submit-tx and wipe-store are relayed to the offscreen document and its answer returned", async () => {
        const { h, sent } = hub((m) => m.type === "submit-tx" ? { ok: true, id: "ab" } : undefined);
        expect(await h.handle({ to: "background", type: "submit-tx", cbor: "84" })).toEqual({ ok: true, id: "ab" });
        expect(sent[0]).toEqual({ to: "offscreen", type: "submit-tx", cbor: "84" });
        expect(await h.handle({ to: "background", type: "wipe-store" })).toMatchObject({ ok: false, error: expect.stringContaining("did not answer") });
    });
});

describe("popup formatting", () => {
    test("numbers, bytes, distance to the tip, tone and connection label", () => {
        expect(fmtNum(1234567)).toBe("1,234,567");
        expect(fmtNum(null)).toBe("–");
        expect(fmtBytes(1536)).toBe("1.5 KiB");
        expect(fmtBytes(3 * 1024 * 1024)).toBe("3.00 MiB");
        expect(fmtSlotsBehind(100, 100)).toBe("at tip");
        expect(fmtSlotsBehind(100, 160)).toBe("60 slots (60 s)");
        expect(fmtSlotsBehind(0, 7200)).toBe("7,200 slots (2.0 h)");
        expect(stateTone("at-tip", 500)).toBe("ok");
        expect(stateTone("at-tip", 9000)).toBe("warn");
        expect(stateTone("error", 100)).toBe("bad");
        expect(connectionLabel(null)).toBe("node not reporting");
        expect(connectionLabel({ nextRetryAt: 5_000, connects: 2 }, 1_000)).toBe("reconnecting in 4 s (attempt 3)");
        expect(connectionLabel({ state: "at-tip", endpoint: "ws://x", keepAliveRttMs: 12 })).toBe("at-tip · ws://x · rtt 12 ms");
    });

    test("sync ring, epoch bar and short durations", () => {
        expect(intersectSlot("slot 126027349")).toBe(126027349);
        expect(intersectSlot("origin")).toBe(0);
        expect(intersectSlot("")).toBeNull();
        expect(syncPercent(1000, null, 5000)).toBe(0);
        expect(syncPercent(1000, 3000, 5000)).toBe(50);
        expect(syncPercent(1000, 4900, 5000)).toBe(100); // within two minutes of the relay counts as caught up
        expect(syncPercent(null, 2500, 10_000)).toBe(25); // no intersection yet: measured from slot 0
        // preview: epoch = slot / 86 400 (epoch 1458 at slot 126 027 349, as the relay's light query reported)
        const pv = epochProgress("preview", 126_027_349)!;
        expect(pv.epoch).toBe(1458);
        expect(pv.slotsLeft).toBe(86_400 - (126_027_349 % 86_400));
        // preprod: four Byron epochs of 21 600 slots, then 432 000-slot epochs from slot 86 400
        expect(epochProgress("preprod", 86_400)).toEqual({ epoch: 4, percent: 0, slotsLeft: 432_000 });
        expect(epochProgress("preprod", 100)).toBeNull();
        expect(epochProgress("nowhere", 100)).toBeNull();
        expect(fmtSlotsShort(45)).toBe("45 s");
        expect(fmtSlotsShort(720)).toBe("12 min");
        expect(fmtSlotsShort(12_240)).toBe("3.4 h");
    });
});

describe("phase 3: extra relays setting", () => {
    test("extra relays are trimmed, deduplicated, never the main relay, at most four", async () => {
        const { normalizeSettings, settingsErrors } = await import("../src/extension/settings");
        const s = normalizeSettings({ relayUrl: "ws://a/n2n", extraRelays: [" ws://b/n2n ", "ws://b/n2n", "ws://a/n2n", "http://x", "ws://c/n2n", "ws://d/n2n", "ws://e/n2n", "ws://f/n2n"] });
        expect(s.extraRelays).toEqual(["ws://b/n2n", "ws://c/n2n", "ws://d/n2n", "ws://e/n2n"]);
        expect(settingsErrors({ extraRelays: ["ftp://x"] })).toHaveLength(1);
        expect(settingsErrors({ extraRelays: ["ws://1", "ws://2", "ws://3", "ws://4", "ws://5"] })).toHaveLength(1);
        expect(settingsErrors({ extraRelays: [] })).toHaveLength(0);
    });
});
