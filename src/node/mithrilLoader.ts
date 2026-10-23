/**
 * Optional Mithril start. The certificate verifier lives in `src/mithril/` (written separately) and is
 * not needed for the default start, so it is never imported statically: the build bundles it into
 * `dist/mithril.js` when it exists, and this loader imports it at run time. When it is missing (or
 * fails to load), `loadMithrilAnchor` resolves to null and the node reports that the Mithril start is
 * unavailable instead of failing to build or start.
 */
import type { LightQueryClient } from "./lightQuery";

export interface MithrilAnchor {
    slot: number;
    hash: string;
    [k: string]: unknown;
}

export type MithrilAnchorFn = (opts: { network: string; lq: LightQueryClient; log?: (l: string) => void }) => Promise<MithrilAnchor>;

/** Where the verifier may be found: the bundled extension file first, then the sources (Bun). */
export const MITHRIL_CANDIDATES = ["./mithril.js", "../mithril/index.ts", "../mithril/mithrilAnchor.ts"];

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
