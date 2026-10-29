/**
 * Popup (and the same page opened in a tab with `?view=tab`): the node's status in the look of Gerolamo's desktop
 * app, its settings and a transaction box. Vanilla DOM; polls the background once a second.
 */
import { connectionLabel, epochProgress, fmtBytes, fmtNum, fmtSlotsBehind, fmtSlotsShort, intersectSlot, stateTone, syncPercent } from "./format";
import type { StatusReply } from "./messages";
import { trustView } from "./trustView";
import { DEFAULT_SETTINGS, MAX_EXTRA_RELAYS, validRelayUrl, type Settings } from "./settings";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T = any>(m: object): Promise<T> => chrome.runtime.sendMessage({ to: "background", ...m });
const RING_C = 2 * Math.PI * 41;
/** "popup" (toolbar), "tab" (full page) or "panel" (the browser's side panel). */
const view = new URLSearchParams(location.search).get("view") ?? "popup";
const wide = view === "tab";
let formDirty = false;
let newestBlock: number | null = null;
/** The settings the background last reported (source for every edit) and the live peer verdicts. */
let currentSettings: Settings | null = null;
let livePeers: Array<{ url: string; verdict: string; detail: string }> = [];

if (wide) document.body.classList.add("wide");
if (view === "panel") document.body.classList.add("panel");
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
    currentSettings = s;
    if (formDirty) return;
    $<HTMLInputElement>("relayUrl").value = s.relayUrl;
    $<HTMLSelectElement>("network").value = s.network;
    $<HTMLSelectElement>("startMode").value = s.startMode;
    $<HTMLInputElement>("certifiedStake").checked = s.certifiedStake !== false;
    $<HTMLInputElement>("txProofs").checked = s.txProofs !== false;
    $<HTMLSelectElement>("mithrilDigests").value = s.mithrilDigests ?? "peer";
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
        tr.addEventListener("click", () => { void runQuery(`/blocks/${b.hash}`); });
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
    // what the relay announced: its light-query services, standard N2N only, or nothing (a relay from before the CIP)
    setText("s-version-sub", s.services?.length ? s.services.join(" · ") : s.wsProtocol === "cardano-n2n.v1" ? "standard N2N only" : s.lightQuery ? "light query" : s.lightQuery === false ? "no light query" : "");

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
    setText("s-indexed", s.indexedBlocks != null ? `${fmtNum(s.indexedBlocks)} blocks answer locally` : "–");
    setText("s-stored", `${fmtNum(s.storedBlocks)} blocks${s.storedTipSlot != null ? ` · tip slot ${fmtNum(s.storedTipSlot)}` : ""}${s.resumedFrom != null ? ` · resumed at ${fmtNum(s.resumedFrom)}` : ""}`);
    setText("s-ledger", s.ledgerBlocks ? `${fmtNum(s.ledgerBlocks)} blocks · ${fmtNum(s.ledgerUtxoCount)} UTxO${s.ledgerCoverageStart != null ? ` · from slot ${fmtNum(s.ledgerCoverageStart)}` : ""}` : "waiting for coverage", `mono ${s.ledgerError || s.ledgerStale ? "bad" : ""}`);

    renderTrust(s);
    livePeers = (s?.peers ?? []) as Array<{ url: string; verdict: string; detail: string }>;
    renderPeers();

    const errs: string[] = s.errors ?? [];
    $("errors-section").hidden = errs.length === 0;
    list("errors", errs.slice(-8).reverse());
    renderRecent(s.recent ?? []);
    list("pending", (s.pendingTxs ?? []).map((t: any) => `${t.id.slice(0, 20)}… ${t.state} (${t.size} B)`));
    list("log", r.logs.slice(-60).reverse());
}

// ---- Trust panel ----
function renderTrust(s: any): void {
    const v = trustView(s);
    const badge = $("trust-verdict");
    badge.textContent = v.verdict.label;
    badge.className = `badge tone-${v.verdict.tone}`;
    $("trust-detail").textContent = v.verdict.detail;
    $("trust-rows").replaceChildren(...v.rows.map((r) => {
        const li = document.createElement("li");
        li.className = `tone-${r.tone}`;
        if (r.tip) li.setAttribute("data-tooltip", r.tip);
        const dot = document.createElement("span"); dot.className = "tdot";
        const label = document.createElement("span"); label.className = "tlabel"; label.textContent = r.label;
        const value = document.createElement("span"); value.className = "tvalue"; value.textContent = r.value;
        li.append(dot, label, value);
        return li;
    }));
    // the main peer, then each extra relay's cross-check
    const TONE: Record<string, string> = { agree: "verified", fork: "warning", behind: "warning", ahead: "warning", pending: "pending", down: "pending" };
    const peers: Array<{ url: string; verdict: string; detail: string }> = s?.peers ?? [];
    const rows = peers.length ? [{ url: s.endpoint, verdict: "main", detail: "main peer: blocks, nonce and stake" }, ...peers] : [];
    $("peer-rows").replaceChildren(...rows.map((p) => {
        const li = document.createElement("li");
        li.className = `tone-${p.verdict === "main" ? "verified" : TONE[p.verdict] ?? "pending"}`;
        li.setAttribute("data-tooltip", p.detail);
        const dot = document.createElement("span"); dot.className = "tdot";
        const url = document.createElement("span"); url.className = "tlabel mono"; url.textContent = p.url.replace(/^wss?:\/\//, "");
        const v = document.createElement("span"); v.className = "tvalue"; v.textContent = p.verdict === "main" ? "main" : p.verdict;
        li.append(dot, url, v);
        return li;
    }));
    const f = (s?.failovers ?? []).at(-1);
    $("failover").textContent = f ? `Switched to ${f.to.replace(/^wss?:\/\//, "")} at ${new Date(f.at).toLocaleTimeString()}: ${f.reason}.` : "";
}

// ---- Peers: the configured list (main + extras) with live verdicts, add/remove/make-main ----
function peerKey(u: string): string {
    return u.trim().replace(/\/+$/, "").toLowerCase();
}

/** Accept ws://host:port/n2n; prepend ws:// when the scheme is missing; null when invalid. */
function normalizePeer(raw: string): string | null {
    let t = raw.trim().replace(/\s+/g, "");
    if (!t) return null;
    if (!/^wss?:\/\//i.test(t)) t = `ws://${t}`;
    t = t.replace(/\/+$/, "");
    return validRelayUrl(t) ? t : null;
}

/** Verdict → tone class (tone-verified, tone-trusted, tone-warning, tone-pending). */
const PEER_TONE: Record<string, string> = {
    main: "verified",
    agree: "verified",
    behind: "trusted",
    ahead: "trusted",
    fork: "warning",
    pending: "pending",
    down: "pending",
    offline: "pending",
};

function renderPeers(): void {
    const list = $("peer-editor");
    const settings = currentSettings;
    const extras = settings?.extraRelays ?? [];
    $("peer-count").textContent = `${extras.length}/${MAX_EXTRA_RELAYS} extra`;
    const addBtn = $<HTMLButtonElement>("peer-add-btn");
    addBtn.disabled = extras.length >= MAX_EXTRA_RELAYS;
    addBtn.setAttribute("data-tooltip", addBtn.disabled ? `Remove one first: at most ${MAX_EXTRA_RELAYS} extra relays` : "Validated ws:// or wss://host:port/n2n URL");
    if (!settings) {
        list.replaceChildren(Object.assign(document.createElement("li"), { className: "dim", textContent: "Waiting for the node's settings…" }));
        return;
    }
    const verdictOf = (url: string): { verdict: string; detail: string } => {
        if (peerKey(url) === peerKey(settings.relayUrl)) return { verdict: "main", detail: "main peer: blocks, nonce and stake" };
        const live = livePeers.find((p) => peerKey(p.url) === peerKey(url));
        return live ? { verdict: live.verdict, detail: live.detail } : { verdict: "offline", detail: "configured, not connected in this session" };
    };
    const row = (url: string, isMain: boolean, index: number): HTMLElement => {
        const st = verdictOf(url);
        const tone = PEER_TONE[st.verdict] ?? "pending";
        const li = document.createElement("li");
        li.className = `tone-${tone}`;
        li.setAttribute("data-tooltip", st.detail);
        const dot = document.createElement("span"); dot.className = "tdot";
        const name = document.createElement("span"); name.className = "tlabel mono"; name.textContent = url.replace(/^wss?:\/\//, "");
        const badge = document.createElement("span"); badge.className = `badge tone-${tone}`; badge.textContent = isMain ? "main relay" : st.verdict;
        badge.setAttribute("data-tooltip", isMain ? "Main relay: change it in Settings → Relay URL" : st.detail);
        li.append(dot, name, badge);
        const actions = document.createElement("span"); actions.className = "peer-actions";
        if (!isMain) {
            const makeMain = document.createElement("button"); makeMain.type = "button"; makeMain.className = "btn small ghost"; makeMain.textContent = "Make main";
            makeMain.addEventListener("click", () => {
                const patch = { relayUrl: url, extraRelays: extras.map((u, i) => (i === index ? settings.relayUrl : u)) };
                void savePeerEdit(patch, `Swapped main to ${url.replace(/^wss?:\/\//, "")}`);
            });
            const remove = document.createElement("button"); remove.type = "button"; remove.className = "btn small danger"; remove.textContent = "Remove";
            remove.addEventListener("click", () => {
                const patch = { extraRelays: extras.filter((u) => peerKey(u) !== peerKey(url)) };
                void savePeerEdit(patch, `Removed ${url.replace(/^wss?:\/\//, "")}`);
            });
            actions.append(makeMain, remove);
            li.append(actions);
        }
        return li;
    };
    list.replaceChildren(row(settings.relayUrl, true, -1), ...extras.map((u, i) => row(u, false, i)));
    if (!extras.length) {
        const hint = document.createElement("li"); hint.className = "dim peer-empty";
        hint.textContent = "No extra peers yet — add one below.";
        list.append(hint);
    }
}

/** Save one peer edit against the settings the background reported (everything else unchanged). */
async function savePeerEdit(patch: Partial<Pick<Settings, "relayUrl" | "extraRelays">>, okText: string): Promise<void> {
    const base = currentSettings;
    if (!base) { message("peer-msg", "Waiting for the node's settings…", false); return; }
    const next: Settings = { ...base, ...patch };
    const r = await send<{ ok: boolean; error?: string }>({ type: "set-settings", settings: next });
    message("peer-msg", r?.ok ? `${okText}; node restarted.` : `Not saved: ${r?.error ?? "no answer"}`, !!r?.ok);
    if (r?.ok) currentSettings = next;
    void poll();
}

// ---- Query: local first, then the Gerolamo peer ----
const SOURCE_LABEL: Record<string, [string, string]> = {
    local: ["verified locally", "success"],
    relay: ["from Gerolamo", "cyan"],
    none: ["unavailable", "bad"],
};

async function runQuery(path: string): Promise<void> {
    const input = $<HTMLInputElement>("query-path");
    input.value = path;
    const run = $<HTMLButtonElement>("query-run");
    run.disabled = true;
    $("query-result").hidden = false;
    $("query-source").textContent = "asking…";
    $("query-source").className = "badge muted";
    $("query-status").textContent = "";
    $("query-body").textContent = "";
    $("query-proof").hidden = true;
    try {
        const r = await send<{ ok: boolean; answer?: { source: string; status: number; body: unknown; peer?: string; ms: number; proof?: { status: string; detail: string } }; error?: string }>({ type: "query", path });
        if (!r?.ok || !r.answer) throw new Error(r?.error ?? "no answer");
        const a = r.answer;
        const [label, tone] = SOURCE_LABEL[a.source] ?? [a.source, "muted"];
        $("query-source").textContent = label;
        $("query-source").className = `badge ${tone}`;
        if (a.peer) $("query-source").setAttribute("data-tooltip", a.peer); else $("query-source").removeAttribute("data-tooltip");
        $("query-status").textContent = `${a.status} · ${a.ms} ms${a.peer ? ` · ${a.peer.replace(/^wss?:\/\//, "")}` : ""}`;
        $("query-body").textContent = typeof a.body === "string" ? a.body : JSON.stringify(a.body, null, 2);
        if (a.proof) {
            const PROOF: Record<string, [string, string]> = { certified: ["Mithril-proven", "tone-verified"], "too-new": ["too new for Mithril", "muted"], mismatch: ["Mithril disagrees", "bad"], unavailable: ["not proven", "muted"] };
            const [text, cls] = PROOF[a.proof.status] ?? ["?", "muted"];
            const el = $("query-proof");
            el.textContent = text; el.className = `badge ${cls}`; el.setAttribute("data-tooltip", a.proof.detail); el.hidden = false;
        }
    } catch (e) {
        $("query-source").textContent = "error";
        $("query-source").className = "badge bad";
        $("query-body").textContent = (e as Error).message;
    } finally { run.disabled = false; }
}

$("query-form").addEventListener("submit", (ev) => { ev.preventDefault(); void runQuery($<HTMLInputElement>("query-path").value); });
for (const chip of Array.from(document.querySelectorAll<HTMLButtonElement>("#query-chips .chip"))) {
    chip.addEventListener("click", () => {
        const path = chip.dataset.path ?? "/";
        const input = $<HTMLInputElement>("query-path");
        if (chip.dataset.hint) {
            // a path that needs an argument: fill the prefix and let the user paste the rest
            input.value = path + (path.startsWith("/addresses/") ? "/utxos" : "");
            input.focus();
            input.setSelectionRange(path.length, path.length);
            input.placeholder = chip.dataset.hint;
            return;
        }
        void runQuery(path);
    });
}

async function poll(): Promise<void> {
    try { const r = await send<{ ok: boolean } & StatusReply>({ type: "get-status" }); if (r?.ok) render(r); }
    catch { $("state").textContent = "no background"; $("state").className = "badge bad"; setLive("off", "Offline"); }
}

function message(id: string, text: string, ok: boolean): void {
    $(id).textContent = text;
    $(id).className = `small ${ok ? "ok" : "bad"}`;
}

// ---- sites allowed to use window.cardano.gerolamino (dappApi.ts) ----
async function renderSites(): Promise<void> {
    const r = await send<{ ok: boolean; sites?: Array<{ origin: string; approvedAt: number }> }>({ type: "dapp-list" });
    const sites = r?.sites ?? [];
    $("sites").replaceChildren(...(sites.length ? sites.map((s) => {
        const li = document.createElement("li");
        const name = document.createElement("span"); name.textContent = s.origin; name.title = `allowed ${new Date(s.approvedAt).toLocaleString()}`;
        const btn = document.createElement("button"); btn.className = "btn danger small"; btn.textContent = "Remove"; btn.type = "button";
        btn.addEventListener("click", async () => { await send({ type: "dapp-revoke", origin: s.origin }); void renderSites(); });
        li.append(name, btn);
        return li;
    }) : [Object.assign(document.createElement("li"), { className: "dim", textContent: "none" })]));
}
void renderSites();

$("settings").addEventListener("input", () => { formDirty = true; });
$("settings").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const base = currentSettings ?? DEFAULT_SETTINGS;
    const settings: Settings = {
        ...base,
        relayUrl: $<HTMLInputElement>("relayUrl").value.trim(),
        network: $<HTMLSelectElement>("network").value as Settings["network"],
        startMode: $<HTMLSelectElement>("startMode").value as Settings["startMode"],
        extraRelays: base.extraRelays ?? [],
        certifiedStake: $<HTMLInputElement>("certifiedStake").checked,
        txProofs: $<HTMLInputElement>("txProofs").checked,
        mithrilDigests: $<HTMLSelectElement>("mithrilDigests").value as Settings["mithrilDigests"],
    };
    const r = await send({ type: "set-settings", settings });
    message("settings-msg", r?.ok ? "Saved; the node restarted." : `Not saved: ${r?.error ?? "no answer"}`, !!r?.ok);
    if (r?.ok) { formDirty = false; newestBlock = null; currentSettings = settings; }
    void poll();
});

// Add a peer: validated, de-duplicated against the main relay and the list, capped at MAX_EXTRA_RELAYS.
$("peer-add").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = $<HTMLInputElement>("peer-url");
    const base = currentSettings;
    if (!base) { message("peer-msg", "Waiting for the node's settings…", false); return; }
    const url = normalizePeer(input.value);
    if (!url) { message("peer-msg", "Enter ws:// or wss://host:port/n2n", false); return; }
    if (peerKey(url) === peerKey(base.relayUrl)) { message("peer-msg", "That is already the main relay — use Make main to swap.", false); return; }
    const extras = base.extraRelays ?? [];
    if (extras.some((u) => peerKey(u) === peerKey(url))) { message("peer-msg", "Already in the peer list.", false); return; }
    if (extras.length >= MAX_EXTRA_RELAYS) { message("peer-msg", `At most ${MAX_EXTRA_RELAYS} extra relays — remove one first.`, false); return; }
    input.value = "";
    await savePeerEdit({ extraRelays: [...extras, url] }, `Added ${url.replace(/^wss?:\/\//, "")}`);
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
    if (!confirm("Delete the stored chain and the local UTxO ledger for this network from the browser? The node will sync again from the relay.")) return;
    const r = await send({ type: "wipe-store" });
    message("settings-msg", r?.ok ? "Stored chain and local ledger wiped." : `Wipe failed: ${r?.error ?? "no answer"}`, !!r?.ok);
    newestBlock = null;
});
// "Open in a tab": the same page, full width.
const tabBtn = $<HTMLButtonElement>("btn-tab");
if (wide) tabBtn.hidden = true;
tabBtn.addEventListener("click", () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?view=tab") });
    if (view === "popup") window.close();
});

// "Open in the side panel": docked beside the page, stays open while browsing. The browser only opens it inside a
// user gesture, so the window id is looked up first and the click calls sidePanel.open directly.
const sidePanel = (globalThis as any).chrome?.sidePanel as typeof chrome.sidePanel | undefined;
const panelBtn = $<HTMLButtonElement>("btn-panel");
let windowId: number | undefined;
if (sidePanel?.open && view !== "panel") {
    panelBtn.hidden = false;
    chrome.windows.getCurrent().then((w) => { windowId = w.id; }).catch(() => { /* keep undefined */ });
}
panelBtn.addEventListener("click", () => {
    if (!sidePanel || windowId === undefined) { $("view-msg").textContent = "Side panel not available here"; return; }
    sidePanel.open({ windowId })
        .then(() => { if (view === "popup") window.close(); })
        .catch((e: Error) => { $("view-msg").textContent = `Side panel: ${e.message}`; });
});

void poll();
setInterval(() => { void poll(); }, 1000);
