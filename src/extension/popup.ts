/**
 * Popup (and the same page opened in a tab with `?view=tab`): the node's status in the look of Gerolamo's desktop
 * app, its settings and a transaction box. Vanilla DOM; polls the background once a second.
 */
import { connectionLabel, epochProgress, fmtBytes, fmtNum, fmtSlotsBehind, fmtSlotsShort, intersectSlot, stateTone, syncPercent } from "./format";
import type { StatusReply } from "./messages";
import type { Settings } from "./settings";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T = any>(m: object): Promise<T> => chrome.runtime.sendMessage({ to: "background", ...m });
const RING_C = 2 * Math.PI * 41;
const wide = new URLSearchParams(location.search).get("view") === "tab";
let formDirty = false;
let newestBlock: number | null = null;

if (wide) document.body.classList.add("wide");
try { $("version").textContent = `Gerolamino ${chrome.runtime.getManifest().version}`; } catch { /* outside the extension */ }
$("ring-arc").setAttribute("stroke-dasharray", String(RING_C));
$("ring-arc").setAttribute("stroke-dashoffset", String(RING_C));

function setText(id: string, text: string, cls?: string): void {
    const el = $(id);
    el.textContent = text;
    if (cls !== undefined) el.className = cls;
}

function list(id: string, items: string[]): void {
    $(id).replaceChildren(...items.map((t) => { const li = document.createElement("li"); li.textContent = t; return li; }));
}

function fillForm(s: Settings): void {
    if (formDirty) return;
    $<HTMLInputElement>("relayUrl").value = s.relayUrl;
    $<HTMLSelectElement>("network").value = s.network;
    $<HTMLSelectElement>("startMode").value = s.startMode;
}

const START_LABEL: Record<string, string> = { tip: "tip sync", chunk: "chunk start", mithril: "Mithril start", resume: "resumed", point: "from a point" };

function setLive(kind: "on" | "off" | "wait", label: string): void {
    $("live-dot").className = `dot ${kind}`;
    $("live-label").textContent = label;
}

function setProgress(pct: number): void {
    const done = pct >= 99.95;
    $("ring-arc").setAttribute("stroke-dashoffset", String(RING_C * (1 - pct / 100)));
    $("ring-arc").classList.toggle("done", done);
    $("ring-pct").textContent = pct.toFixed(1);
    const bar = $("sync-bar");
    bar.style.width = `${pct}%`;
    bar.classList.toggle("done", done);
    $("sync-pct-text").textContent = `${pct.toFixed(2)}%`;
}

function renderRecent(rows: Array<{ slot: number; blockNo: number; hash: string; size: number; txs: number }>): void {
    const body = $("recent");
    if (!rows.length) return;
    const prevNewest = newestBlock;
    newestBlock = rows[0]!.blockNo;
    body.replaceChildren(...rows.map((b) => {
        const tr = document.createElement("tr");
        if (prevNewest != null && b.blockNo > prevNewest) tr.className = "fresh";
        for (const t of [`#${fmtNum(b.blockNo)}`, fmtNum(b.slot), String(b.txs), fmtBytes(b.size), String(b.hash)]) {
            const td = document.createElement("td");
            td.textContent = t;
            tr.append(td);
        }
        tr.lastElementChild!.setAttribute("title", String(b.hash));
        return tr;
    }));
}

function render(r: StatusReply): void {
    const s: any = r.status;
    const network = r.settings.network;
    fillForm(r.settings);
    $("net-badge").textContent = network.toUpperCase();
    const stale = (r.statusAgeMs ?? 0) > 5000;
    const tone = stateTone(s?.state, r.statusAgeMs);
    const badge = $("state");
    badge.textContent = !s ? "starting" : stale ? "not reporting" : s.state;
    badge.className = `badge ${tone || "muted"}`;
    if (!s || stale) setLive("off", stale ? "Not reporting" : "Starting");
    else if (s.state === "syncing" || s.state === "at-tip") setLive("on", "Online");
    else if (s.state === "error" || s.state === "stopped") setLive("off", "Offline");
    else setLive("wait", s.nextRetryAt ? "Reconnecting" : "Connecting");
    if (!s) return;

    const mode = $("mode-badge");
    mode.hidden = false;
    mode.textContent = START_LABEL[s.startMode] ?? String(s.startMode ?? "tip sync");
    $("validation-badge").hidden = !(s.cryptoOk > 0 && !s.cryptoBad && !s.leaderBad && !s.bodyBad && !s.linkBad);

    const ours: number | null = s.lastSlot ?? s.storedTipSlot ?? null;
    const relay: number | null = s.serverTip?.slot ?? null;
    setProgress(syncPercent(intersectSlot(s.intersect), ours, relay));
    const ep = epochProgress(network, ours);
    $("epoch-row").hidden = !ep;
    $("epoch-badge").hidden = !ep;
    if (ep) {
        $("epoch-badge").textContent = `Epoch ${ep.epoch}`;
        $("epoch-num").textContent = String(ep.epoch);
        $("epoch-text").textContent = `${ep.percent.toFixed(1)}% · ${fmtSlotsShort(ep.slotsLeft)} left`;
        $("epoch-bar").style.width = `${ep.percent}%`;
    }
    setText("s-conn", connectionLabel(s));

    setText("t-ours", ours != null ? fmtNum(ours) : "–");
    setText("t-ours-sub", s.lastBlockNo != null ? `#${fmtNum(s.lastBlockNo)}` : "");
    setText("t-relay", relay != null ? fmtNum(relay) : "–");
    setText("t-relay-sub", s.serverTip ? `#${fmtNum(s.serverTip.blockNo)}` : "");
    const behind = ours != null && relay != null ? Math.max(0, relay - ours) : null;
    setText("s-behind", behind == null ? "–" : behind <= 0 ? "at tip" : fmtSlotsShort(behind), `value ${behind == null ? "" : behind <= 120 ? "ok glow" : "warn"}`);
    $("s-behind").parentElement!.setAttribute("data-tooltip", `Slots between our tip and the relay's (${fmtSlotsBehind(ours, relay)}). One slot is one second.`);
    setText("s-version", s.version != null ? `v${s.version}` : "–");
    setText("s-version-sub", s.lightQuery ? "light query" : s.lightQuery === false ? "no light query" : "");

    setText("s-headers", fmtNum(s.headers), `value ${s.linkBad ? "bad" : ""}`);
    setText("s-headers-sub", s.linkBad ? `${fmtNum(s.linkBad)} broken links` : `${fmtNum(s.linkOk)} linked`);
    const checked = s.cryptoOk + s.cryptoBad;
    setText("s-crypto", `${fmtNum(s.cryptoOk)} | ${fmtNum(s.cryptoBad)}`, `value ${s.cryptoBad ? "bad" : s.cryptoOk ? "ok glow" : ""}`);
    setText("s-crypto-sub", checked ? `${(s.cryptoMs / checked).toFixed(0)} ms/header${s.cryptoSkipped ? ` · ${fmtNum(s.cryptoSkipped)} skipped` : ""}` : s.cryptoSkipped ? `${fmtNum(s.cryptoSkipped)} skipped` : "");
    setText("s-leader", `${fmtNum(s.leaderOk)} | ${fmtNum(s.leaderBad)}`, `value ${s.leaderBad ? "bad" : s.leaderOk ? "ok glow" : ""}`);
    setText("s-leader-sub", s.leaderSkipped ? `${fmtNum(s.leaderSkipped)} skipped` : s.nonceEpoch != null ? `nonce epoch ${s.nonceEpoch}` : "");
    setText("s-blocks", fmtNum(s.bodyOk), `value ${s.bodyBad ? "bad" : ""}`);
    setText("s-blocks-sub", s.bodyBad ? `${fmtNum(s.bodyBad)} bad of ${fmtNum(s.blocksFetched)}` : `of ${fmtNum(s.blocksFetched)} fetched`);
    setText("s-rollbacks", fmtNum(s.rollbacks));
    setText("s-rollbacks-sub", s.rolledBackBlocks ? `${fmtNum(s.rolledBackBlocks)} blocks undone` : "");
    setText("s-bytes", fmtBytes(s.bytes));
    setText("s-rtt", s.keepAliveRttMs != null ? `rtt ${s.keepAliveRttMs} ms` : "");

    setText("s-opfs", s.opfs ? `${fmtBytes(s.opfs.bytes)} in ${fmtNum(s.opfs.files)} files, ${fmtNum(s.opfs.chunks)} chunk(s)` : "unavailable");
    setText("s-stored", `${fmtNum(s.storedBlocks)} blocks${s.storedTipSlot != null ? ` · tip slot ${fmtNum(s.storedTipSlot)}` : ""}${s.resumedFrom != null ? ` · resumed at ${fmtNum(s.resumedFrom)}` : ""}`);

    const errs: string[] = s.errors ?? [];
    $("errors-section").hidden = errs.length === 0;
    list("errors", errs.slice(-8).reverse());
    renderRecent(s.recent ?? []);
    list("pending", (s.pendingTxs ?? []).map((t: any) => `${t.id.slice(0, 20)}… ${t.state} (${t.size} B)`));
    list("log", r.logs.slice(-60).reverse());
}

async function poll(): Promise<void> {
    try { const r = await send<{ ok: boolean } & StatusReply>({ type: "get-status" }); if (r?.ok) render(r); }
    catch { $("state").textContent = "no background"; $("state").className = "badge bad"; setLive("off", "Offline"); }
}

function message(id: string, text: string, ok: boolean): void {
    $(id).textContent = text;
    $(id).className = `small ${ok ? "ok" : "bad"}`;
}

$("settings").addEventListener("input", () => { formDirty = true; });
$("settings").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const settings = { relayUrl: $<HTMLInputElement>("relayUrl").value.trim(), network: $<HTMLSelectElement>("network").value, startMode: $<HTMLSelectElement>("startMode").value };
    const r = await send({ type: "set-settings", settings });
    message("settings-msg", r?.ok ? "Saved; the node restarted." : `Not saved: ${r?.error ?? "no answer"}`, !!r?.ok);
    if (r?.ok) { formDirty = false; newestBlock = null; }
    void poll();
});
$("submit").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("submit");
    btn.disabled = true;
    try {
        const r = await send({ type: "submit-tx", cbor: $<HTMLTextAreaElement>("tx").value });
        message("tx-msg", r?.ok ? `Queued ${String(r.id).slice(0, 16)}…` : `Failed: ${r?.error ?? "no answer"}`, !!r?.ok);
        if (r?.ok) $<HTMLTextAreaElement>("tx").value = "";
    } finally { btn.disabled = false; }
});
$("wipe").addEventListener("click", async () => {
    if (!confirm("Delete the stored chain for this network from the browser? The node will sync again from the relay.")) return;
    const r = await send({ type: "wipe-store" });
    message("settings-msg", r?.ok ? "Stored chain wiped." : `Wipe failed: ${r?.error ?? "no answer"}`, !!r?.ok);
    newestBlock = null;
});
const openTab = $<HTMLAnchorElement>("open-tab");
if (wide) openTab.hidden = true;
openTab.addEventListener("click", (ev) => {
    ev.preventDefault();
    void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?view=tab") });
    window.close();
});

void poll();
setInterval(() => { void poll(); }, 1000);
