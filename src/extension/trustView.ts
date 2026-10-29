/**
 * The popup's trust panel (pure, unit tested): what this node verified itself and what it still takes from its
 * peers, row by row, with an overall verdict. "verified" rows cannot be faked by a peer; "trusted" rows can;
 * "warning" rows mean something looks wrong right now.
 */
export type TrustTone = "verified" | "trusted" | "warning" | "pending";

export interface TrustRow { key: string; label: string; value: string; tone: TrustTone; tip: string }
export interface TrustView { verdict: { label: string; tone: TrustTone; detail: string }; rows: TrustRow[] }

/** The fields of the node's stats the panel reads (all optional: older stats lack some). */
export interface TrustInput {
    cryptoOk?: number; cryptoBad?: number; leaderOk?: number; leaderBad?: number; bodyBad?: number; linkBad?: number;
    lightQuery?: boolean | null;
    startMode?: string;
    /** The local UTxO ledger (P0): counters and coverage; absent in older stats. */
    ledgerBlocks?: number; ledgerUtxoCount?: number; ledgerCoverageStart?: number | null; ledgerTipSlot?: number | null;
    ledgerDigest?: string | null; ledgerStale?: boolean; ledgerError?: string | null;
    trust?: {
        freshness?: { status: string; lagSlots: number | null } | null;
        density?: { status: string; ratio: number | null; pools: number; coveredSlots: number; windowSlots: number };
        anchor?: { source: string; detail?: string } | null;
        nonce?: { source: string; pools?: number; peersAgreeing?: number; peersAsked?: number; peersDisagreeing?: number } | null;
        stake?: { source: string; epoch?: number; mismatches?: number; checking?: boolean; error?: string } | null;
        peers?: { total: number; agreeing: number; disagreeing: number; behind: number; down?: number; primary?: string } | null;
    };
}

const mins = (slots: number) => (slots < 120 ? `${slots} s` : `${Math.round(slots / 60)} min`);

export function trustView(s: TrustInput | null | undefined): TrustView {
    const rows: TrustRow[] = [];
    const t = s?.trust ?? {};

    // 1. the blocks themselves
    const bad = (s?.cryptoBad ?? 0) + (s?.leaderBad ?? 0) + (s?.bodyBad ?? 0) + (s?.linkBad ?? 0);
    rows.push(!s || !s.cryptoOk
        ? { key: "blocks", label: "Block signatures", value: s?.lightQuery === false ? "not checked: the peer gives no nonce" : "waiting for headers", tone: s?.lightQuery === false ? "warning" : "pending", tip: "Each header's operational certificate, KES signature and VRF proof, the pool's right to lead the slot, and the body hash." }
        : bad
            ? { key: "blocks", label: "Block signatures", value: `${bad} failed`, tone: "warning", tip: "A header or body failed its checks: this peer served something invalid." }
            : { key: "blocks", label: "Block signatures", value: `${s.cryptoOk} verified`, tone: "verified", tip: "Every header's certificate, KES signature, VRF proof and leader eligibility, and every body hash, checked here. A peer cannot forge blocks." });

    // 2. freshness
    const f = t.freshness;
    rows.push(!f || f.status === "unknown"
        ? { key: "fresh", label: "Freshness", value: "no tip yet", tone: "pending", tip: "The peer's tip compared with the clock." }
        : { key: "fresh", label: "Freshness", value: f.status === "fresh" ? `tip ${mins(f.lagSlots ?? 0)} old` : `tip ${mins(f.lagSlots ?? 0)} behind the clock`, tone: f.status === "fresh" ? "verified" : "warning",
            tip: "A block comes every ~20 s on average. A tip many minutes old means the peer is stuck or withholding the chain." });

    // 3. density
    const d = t.density;
    rows.push(!d || d.status === "insufficient"
        ? { key: "density", label: "Chain density", value: d ? `measuring (${Math.round(100 * d.coveredSlots / d.windowSlots)}% of 1 h)` : "measuring", tone: "pending", tip: "Blocks per slot over the last hour of verified headers: an honest chain is as dense as the active stake." }
        : { key: "density", label: "Chain density", value: `${Math.round(100 * (d.ratio ?? 0))}% of the maximum, ${d.pools} pools`, tone: d.status === "ok" ? "verified" : "warning",
            tip: d.status === "ok" ? "As dense as the active stake makes it, from many pools: not a private fork." : "Far sparser than the active stake makes a chain, or from few pools: this may be a private fork." });

    // 4. where the chain was picked up
    const anchor = t.anchor?.source ?? (s?.startMode === "mithril" ? "mithril" : s?.startMode === "resume" ? "stored" : s?.startMode === "resume-mithril" ? "mithril-stored" : s?.startMode === "chunk" ? "peer-chunk" : s?.startMode ? "peer-tip" : undefined);
    rows.push(anchor === "mithril"
        ? { key: "anchor", label: "Start point", value: "Mithril-certified", tone: "verified", tip: "Started from a block certified by the stake pools' Mithril multi-signature, checked back to the genesis key." }
        : anchor === "mithril-stored"
            ? { key: "anchor", label: "Start point", value: "Mithril-certified, resumed", tone: "verified", tip: `This store's blocks begin at a point certified by the stake pools' Mithril multi-signature${t.anchor?.detail ? ` (${t.anchor.detail})` : ""}; verified back to the genesis key before the resume.` }
        : anchor === "stored"
            ? { key: "anchor", label: "Start point", value: "this node's stored chain", tone: "trusted", tip: "Resumed from blocks this node verified earlier; the original start point decides how far that can be trusted." }
            : anchor
                ? { key: "anchor", label: "Start point", value: anchor === "peer-chunk" ? "the peer's immutable chunk" : "the peer's tip", tone: "trusted", tip: "Started where the peer said the chain is. Density and other peers check it; a Mithril start removes the trust." }
                : { key: "anchor", label: "Start point", value: "not started", tone: "pending", tip: "" });

    // 5. epoch nonce
    const n = t.nonce;
    rows.push(!n
        ? { key: "nonce", label: "Epoch nonce", value: s?.lightQuery ? "from the peer" : "none", tone: s?.lightQuery ? "trusted" : "pending", tip: "The nonce every VRF proof of the epoch is checked against." }
        : n.source === "derived"
            ? { key: "nonce", label: "Epoch nonce", value: "computed from the headers", tone: "verified", tip: "Computed here from the previous epoch's verified headers." }
            : (n.peersDisagreeing ?? 0) > 0 && (n.pools ?? 0) < 5
                ? { key: "nonce", label: "Epoch nonce", value: `${n.peersDisagreeing} peer(s) give another nonce`, tone: "warning", tip: "Peers disagree about the epoch nonce and too few pools' VRF proofs have verified yet to tell which one is right." }
            : (n.pools ?? 0) >= 5 || (n.peersAgreeing ?? 0) >= 2
                ? { key: "nonce", label: "Epoch nonce", value: [n.pools ? `confirmed by ${n.pools} pools' VRF proofs` : "", n.peersAgreeing && n.peersAgreeing >= 2 ? `${n.peersAgreeing} peers agree` : ""].filter(Boolean).join(", ") + (n.peersDisagreeing ? `; ${n.peersDisagreeing} peer(s) give a wrong one` : ""), tone: "verified", tip: "A wrong nonce makes every honest pool's VRF proof fail. Proofs from many independent pools verifying with it confirm it." }
                : { key: "nonce", label: "Epoch nonce", value: n.pools ? `from the peer, ${n.pools} pool(s) so far` : "from the peer", tone: "trusted", tip: "Not yet confirmed by enough independent pools' VRF proofs." });

    // 6. stake distribution
    const st = t.stake;
    rows.push(!st
        ? { key: "stake", label: "Pool stake", value: s?.lightQuery ? "from the peer" : "none", tone: s?.lightQuery ? "trusted" : "pending", tip: "The stake each pool may lead with: the leader check depends on it." }
        : st.source === "mithril"
            ? (st.mismatches ?? 0) > 0
                ? { key: "stake", label: "Pool stake", value: `${st.mismatches} peer value(s) disagree with Mithril`, tone: "warning", tip: "The peer's stake figures differ from the Mithril-certified distribution: it may be lying." }
                : { key: "stake", label: "Pool stake", value: `Mithril-certified${st.epoch != null ? ` (epoch ${st.epoch})` : ""}`, tone: "verified", tip: "The stake distribution certified by the stake pools' Mithril multi-signature, not taken from the peer." }
            : { key: "stake", label: "Pool stake", value: st.checking ? "from the peer; Mithril check running" : st.error ? "from the peer (Mithril unavailable)" : "from the peer", tone: "trusted", tip: st.error ? `Mithril: ${st.error}` : "Taken from the peer; a Mithril-certified distribution removes the trust." });

    // 7. peers
    const p = t.peers;
    rows.push(!p || p.total <= 1
        ? { key: "peers", label: "Peers", value: "1 peer, no cross-check", tone: "trusted", tip: "With one peer, withheld blocks or a stale fork go unnoticed. Add more relays in Settings." }
        : p.disagreeing || p.behind
            ? { key: "peers", label: "Peers", value: `${p.agreeing} of ${p.total} agree${p.disagreeing ? `, ${p.disagreeing} on another chain` : ""}${p.behind ? `, ${p.behind} behind` : ""}`, tone: "warning", tip: "Peers disagree about the chain. The longest chain that shares history is followed (the main peer is switched to it) and the others are flagged." }
            : p.agreeing >= 2
                ? { key: "peers", label: "Peers", value: `${p.agreeing} of ${p.total} agree${p.down ? `, ${p.down} down` : ""}`, tone: "verified", tip: "Independent peers serve the same headers." }
            : { key: "peers", label: "Peers", value: `checking ${p.total - 1} more${p.down ? `, ${p.down} down` : ""}`, tone: "trusted", tip: "Extra relays are connecting or have not seen enough of the chain to compare yet." });

    // 8. local UTxO ledger (P0): only when the stats carry it
    if (s?.ledgerBlocks != null) {
        const lb = s.ledgerBlocks, utxos = s.ledgerUtxoCount ?? 0, start = s.ledgerCoverageStart, tip = s.ledgerTipSlot;
        const stale = s.ledgerStale || !!s.ledgerError;
        const complete = start === 0;
        rows.push(stale
            ? { key: "ledger", label: "Local UTxO", value: s.ledgerError ? "stale after an error" : "stale, rebuild pending", tone: "warning", tip: "The local UTxO diff log failed a digest or write check. The chain store is still intact; rebuild the ledger from a snapshot or a verified start." }
            : !lb
                ? { key: "ledger", label: "Local UTxO", value: "waiting for coverage", tone: "pending", tip: "No verified block has fed the local UTxO projection yet." }
                : complete
                    ? { key: "ledger", label: "Local UTxO", value: `${lb} blocks, ${utxos} UTxO from genesis`, tone: "verified", tip: "UTxO state covers the whole chain (genesis or a certified snapshot): address answers are complete." }
                    : { key: "ledger", label: "Local UTxO", value: `${lb} blocks, ${utxos} UTxO from slot ${start ?? "?"}`, tone: "trusted", tip: `UTxO state starts at verified slot ${start ?? "?"}${tip != null ? ` and runs to ${tip}` : ""}; address balances are partial, so address answers default to the Gerolamo peer unless coverage is complete.` });
    }

    const warn = rows.filter((r) => r.tone === "warning");
    const trusted = rows.filter((r) => r.tone === "trusted");
    const pending = rows.filter((r) => r.tone === "pending");
    const verdict = warn.length
        ? { label: "Warning", tone: "warning" as const, detail: warn.map((r) => r.label.toLowerCase()).join(", ") }
        : pending.length === rows.length || (pending.length && !rows.some((r) => r.tone === "verified"))
            ? { label: "Checking", tone: "pending" as const, detail: "waiting for verified headers" }
            : trusted.length
                ? { label: "Partly trusted", tone: "trusted" as const, detail: `still taken from peers: ${trusted.map((r) => r.label.toLowerCase()).join(", ")}` }
                : pending.length
                    ? { label: "Checking", tone: "pending" as const, detail: pending.map((r) => r.label.toLowerCase()).join(", ") }
                    : { label: "Verified", tone: "verified" as const, detail: "nothing taken on trust" };
    return { verdict, rows };
}
