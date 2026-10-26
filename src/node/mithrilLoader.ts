/**
 * Optional Mithril start. The certificate verifier lives in `src/mithril/` (written separately) and is
 * not needed for the default start, so it is never imported statically: the build bundles it into
 * `dist/mithril.js` when it exists, and this loader imports it at run time. When it is missing (or
 * fails to load), `loadMithrilAnchor` resolves to null and the node reports that the Mithril start is
 * unavailable instead of failing to build or start.
 */
import type { LightQueryClient } from "./lightQuery";
import type { TxProofView } from "./txProofCheck";

export interface MithrilAnchor {
    slot: number;
    hash: string;
    [k: string]: unknown;
}

export type MithrilAnchorFn = (opts: { network: string; lq: LightQueryClient; log?: (l: string) => void; digestsFrom?: "peer" | "aggregator" }) => Promise<MithrilAnchor>;

/** The Mithril-certified stake of a leader-election epoch (src/mithril/stake.ts). */
export interface CertifiedStake { leaderEpoch: number; artifactEpoch: number; certificateHash: string; pools: Map<string, bigint>; total: bigint; certificatesWalked: number; ms: number }
export type MithrilStakeFn = (opts: { network: string; epoch: number; log?: (l: string) => void }) => Promise<CertifiedStake>;
/** A verified Mithril proof that transactions are on the chain (src/mithril/txProof.ts). */
export type MithrilTxProofFn = (opts: { network: string; txHashes: string[]; log?: (l: string) => void }) => Promise<TxProofView & { nonCertified: string[] }>;

/** Where the verifier may be found: the bundled extension file first, then the sources (Bun). */
export const MITHRIL_CANDIDATES = ["./mithril.js", "../mithril/index.ts", "../mithril/mithrilAnchor.ts"];

/** A function the Mithril verifier exports, or null when this build has none. */
async function loadMithrilExport<T>(name: string, candidates: string[]): Promise<T | null> {
    for (const c of candidates) {
        let spec: string;
        try { spec = new URL(c, import.meta.url).href; } catch { continue; }
        try { const mod: any = await import(/* runtime specifier, not bundled */ spec); if (typeof mod?.[name] === "function") return mod[name] as T; } catch { /* not present here */ }
    }
    return null;
}

export const loadMithrilStake = (candidates: string[] = MITHRIL_CANDIDATES) => loadMithrilExport<MithrilStakeFn>("mithrilStake", candidates);
export const loadMithrilTxProof = (candidates: string[] = MITHRIL_CANDIDATES) => loadMithrilExport<MithrilTxProofFn>("mithrilTxProof", candidates);

export async function loadMithrilAnchor(candidates: string[] = MITHRIL_CANDIDATES, log?: (l: string) => void): Promise<MithrilAnchorFn | null> {
    for (const c of candidates) {
        let spec: string;
        try { spec = new URL(c, import.meta.url).href; } catch { continue; }
        try {
            const mod: any = await import(/* runtime specifier, not bundled */ spec);
            if (typeof mod?.mithrilAnchor === "function") return mod.mithrilAnchor as MithrilAnchorFn;
            log?.(`mithril: ${c} loaded but exports no mithrilAnchor`);
        } catch { /* not present here */ }
    }
    return null;
}
