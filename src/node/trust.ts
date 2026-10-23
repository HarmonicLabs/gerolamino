/**
 * Can the chain the peers show be trusted? Signature checks stop a peer from forging blocks, but not from showing a
 * stale chain or a private fork. Two cheap checks that need nothing but the verified headers:
 *
 * - **Freshness.** The peer's tip compared with the wall clock. An honest chain makes a block every 1/f slots
 *   (20 on preview, preprod and mainnet); no block for many minutes means the peer is stuck or withholding.
 * - **Density.** Blocks per slot over a recent window, counting only headers whose signatures verified. An honest
 *   chain is as dense as the active stake (f × active fraction, about 0.7 f on preview); a private fork built by a
 *   pool with a small stake is far sparser, and it cannot be made denser without other pools' keys. This is the
 *   idea behind Ouroboros Genesis' chain selection. The distinct pools in the window are counted too.
 */
import type { NetworkParams } from "./networks";
import { unixToSlot } from "./networks";

export const ACTIVE_SLOTS_COEFF = 0.05;
/** Freshness: the peer's tip at most this many slots behind the wall clock is fresh, beyond STALE_SLOTS stale. */
export const FRESH_SLOTS = 300;
export const STALE_SLOTS = 900;
/** Density window (slots) and the ratio to f below which a chain is flagged. */
export const DENSITY_WINDOW = 3600;
export const DENSITY_LOW_RATIO = 0.4;

export interface HeaderObservation {
    slot: number;
    blockNo: number;
    hash: string;
    /** Issuer's pool id (hex, 28 bytes). */
    poolId: string;
}

export type FreshnessStatus = "fresh" | "lagging" | "stale" | "unknown";
export interface Freshness { nowSlot: number; tipSlot: number | null; lagSlots: number | null; status: FreshnessStatus }

export type DensityStatus = "ok" | "low" | "insufficient";
export interface Density {
    status: DensityStatus;
    windowSlots: number;
    /** Slots of chain the window has seen so far (< windowSlots while insufficient). */
    coveredSlots: number;
    blocks: number;
    /** blocks / (f × coveredSlots): about 0.7 on an honest preview chain, near 1 on mainnet. */
    ratio: number | null;
    pools: number;
}

export function freshness(network: NetworkParams, tipSlot: number | null, nowMs = Date.now()): Freshness {
    const nowSlot = unixToSlot(network, nowMs / 1000);
    if (tipSlot == null) return { nowSlot, tipSlot, lagSlots: null, status: "unknown" };
    const lag = Math.max(0, nowSlot - tipSlot);
    return { nowSlot, tipSlot, lagSlots: lag, status: lag <= FRESH_SLOTS ? "fresh" : lag <= STALE_SLOTS ? "lagging" : "stale" };
}

/** The verified headers of the chain being followed, enough for density and distinct-pool counts. */
export class ChainObserver {
    private obs: HeaderObservation[] = [];
    /** The slot where watching began (the chain-sync intersection): coverage counts from here, so a sparse chain
     *  cannot stay "insufficient" by being slow to show its first block. */
    private origin: number | null = null;

    constructor(readonly windowSlots = DENSITY_WINDOW, readonly activeSlotsCoeff = ACTIVE_SLOTS_COEFF) {}

    get size(): number { return this.obs.length; }
    get last(): HeaderObservation | null { return this.obs[this.obs.length - 1] ?? null; }

    /** Start watching at `slot` (the intersection point); keeps an earlier origin. */
    begin(slot: number): void { if (this.origin == null || slot < this.origin) this.origin = slot; }

    /** A header whose signatures verified, in chain order. */
    observe(o: HeaderObservation): void {
        if (this.last && o.slot <= this.last.slot) this.rollbackTo(o.slot - 1);
        this.obs.push(o);
        // keep two windows: enough for the current window wherever the tip moves next
        const keepFrom = o.slot - 2 * this.windowSlots;
        let drop = 0;
        while (drop < this.obs.length && this.obs[drop]!.slot < keepFrom) drop++;
        if (drop) this.obs.splice(0, drop);
        if (this.origin != null && this.origin < keepFrom) this.origin = keepFrom;
    }

    rollbackTo(slot: number): void {
        while (this.obs.length && this.obs[this.obs.length - 1]!.slot > slot) this.obs.pop();
    }

    clear(): void { this.obs = []; this.origin = null; }

    /** Density over the window ending at the newest observed header. */
    density(): Density {
        const last = this.last;
        if (!last) return { status: "insufficient", windowSlots: this.windowSlots, coveredSlots: 0, blocks: 0, ratio: null, pools: 0 };
        const from = last.slot - this.windowSlots;
        const inWindow = this.obs.filter((o) => o.slot > from);
        // coverage runs from where watching began (or the oldest header, when no origin was given)
        const origin = this.origin ?? this.obs[0]!.slot;
        const coveredSlots = Math.min(this.windowSlots, last.slot - origin);
        const pools = new Set(inWindow.map((o) => o.poolId)).size;
        const blocks = inWindow.filter((o) => o.slot > last.slot - coveredSlots).length;
        const ratio = coveredSlots > 0 ? blocks / (this.activeSlotsCoeff * coveredSlots) : null;
        if (coveredSlots < this.windowSlots) return { status: "insufficient", windowSlots: this.windowSlots, coveredSlots, blocks, ratio, pools };
        return { status: ratio! < DENSITY_LOW_RATIO ? "low" : "ok", windowSlots: this.windowSlots, coveredSlots, blocks, ratio, pools };
    }

    /** Distinct pools among the observed headers of one epoch range of slots. */
    poolsBetween(fromSlot: number, toSlot: number): number {
        return new Set(this.obs.filter((o) => o.slot >= fromSlot && o.slot <= toSlot).map((o) => o.poolId)).size;
    }
}
