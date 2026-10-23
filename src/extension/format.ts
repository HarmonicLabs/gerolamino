/** Formatting for the popup (pure, unit tested). */
import { epochOfSlot, networkByName } from "../node/networks";

/** Within this many slots of the relay's tip the node counts as caught up (a block is ~20 slots on every network). */
export const AT_TIP_SLOTS = 120;

/** The slot of the node's `intersect` stat ("slot N", or "origin" for 0); null when it has not intersected yet. */
export function intersectSlot(intersect: string | null | undefined): number | null {
    if (intersect === "origin") return 0;
    const m = /^slot (\d+)$/.exec(intersect ?? "");
    return m ? Number(m[1]) : null;
}

/** Share of the way from the start point to the relay's tip, 0–100; 100 within AT_TIP_SLOTS of it. */
export function syncPercent(start: number | null, ours: number | null | undefined, relay: number | null | undefined): number {
    if (ours == null || relay == null) return 0;
    if (relay - ours <= AT_TIP_SLOTS) return 100;
    const s = start ?? 0;
    if (relay <= s) return 100;
    return Math.max(0, Math.min(100, ((ours - s) / (relay - s)) * 100));
}

/** Epoch of a slot and how far through it the slot is; null for an unknown network or a Byron slot. */
export function epochProgress(network: string, slot: number | null | undefined): { epoch: number; percent: number; slotsLeft: number } | null {
    const n = networkByName(network);
    if (!n || slot == null || slot < n.shelleyStartSlot) return null;
    const into = (slot - n.shelleyStartSlot) % n.epochLength;
    return { epoch: epochOfSlot(n, slot), percent: (into / n.epochLength) * 100, slotsLeft: n.epochLength - into };
}

/** A duration in slots (one second each) as "45 s", "12 min" or "3.4 h". */
export function fmtSlotsShort(d: number): string {
    if (d < 120) return `${d} s`;
    if (d < 7200) return `${Math.round(d / 60)} min`;
    return `${(d / 3600).toFixed(1)} h`;
}
export const fmtNum = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US"));

export function fmtBytes(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return "–";
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MiB`;
    return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

/** Slots are one second on every Shelley-era network. */
export function fmtSlotsBehind(ours: number | null | undefined, theirs: number | null | undefined): string {
    if (ours == null || theirs == null) return "–";
    const d = Math.max(0, theirs - ours);
    if (d === 0) return "at tip";
    if (d < 120) return `${d} slots (${d} s)`;
    if (d < 7200) return `${fmtNum(d)} slots (${Math.round(d / 60)} min)`;
    return `${fmtNum(d)} slots (${(d / 3600).toFixed(1)} h)`;
}

export type Tone = "ok" | "bad" | "warn" | "";

export function stateTone(state: string | undefined, staleMs: number | null): Tone {
    if (staleMs == null || staleMs > 5000) return "warn";
    if (state === "at-tip") return "ok";
    if (state === "error" || state === "stopped") return "bad";
    return "warn";
}

export function connectionLabel(s: { state?: string; endpoint?: string; nextRetryAt?: number | null; connects?: number; keepAliveRttMs?: number | null } | null, now = Date.now()): string {
    if (!s) return "node not reporting";
    if (s.nextRetryAt) return `reconnecting in ${Math.max(0, Math.ceil((s.nextRetryAt - now) / 1000))} s (attempt ${(s.connects ?? 0) + 1})`;
    const rtt = s.keepAliveRttMs != null ? ` · rtt ${s.keepAliveRttMs} ms` : "";
    return `${s.state ?? "?"} · ${s.endpoint ?? ""}${rtt}`;
}
