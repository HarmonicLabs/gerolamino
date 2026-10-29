/**
 * The Mithril-certified start point, kept next to the chunk files (`mithril-anchor.json`) so a resumed store
 * still knows that its base is a point the stake pools' Mithril multi-signature certified. Written once, when
 * the Mithril start verifies; read on resume and shown only when the stored chain still reaches the anchor.
 */
import type { FileSink } from "./chunkWriter";
import type { MithrilAnchor } from "./mithrilLoader";

export const MITHRIL_ANCHOR_FILE = "mithril-anchor.json";

export interface StoredMithrilAnchor {
    slot: number;
    hash: string;
    network?: string;
    epoch?: number;
    certificateHash?: string;
    chunkNo?: number;
    immutableFileNumber?: number;
    merkleRoot?: string;
    /** When it was verified (ms). */
    at?: number;
}

/** Write the anchor from a verified Mithril start; false when there is no store. Errors propagate (the caller logs). */
export async function writeMithrilAnchor(sink: FileSink | null | undefined, a: MithrilAnchor, network: string, at = Date.now()): Promise<boolean> {
    if (!sink) return false;
    const stored: StoredMithrilAnchor = {
        slot: Number(a.slot), hash: String(a.hash), network,
        epoch: typeof a.epoch === "number" ? a.epoch : undefined,
        certificateHash: typeof a.certificateHash === "string" ? a.certificateHash : undefined,
        chunkNo: typeof a.chunkNo === "number" ? a.chunkNo : undefined,
        immutableFileNumber: typeof a.immutableFileNumber === "number" ? a.immutableFileNumber : undefined,
        merkleRoot: typeof a.merkleRoot === "string" ? a.merkleRoot : undefined,
        at,
    };
    await sink.write(MITHRIL_ANCHOR_FILE, new TextEncoder().encode(JSON.stringify(stored)));
    return true;
}

/** A hash32 that is hex: 64 characters. */
function isHash32Hex(h: string): boolean { return /^[0-9a-fA-F]{64}$/.test(h); }

/**
 * Read the stored anchor. `storedTipSlot` is the store's newest block: the anchor is only meaningful when the
 * stored chain still reaches it (an anchor above the stored tip means a stale/wrong file). Null when absent,
 * unreadable, malformed, or beyond the stored chain.
 */
export async function readMithrilAnchor(sink: FileSink | null | undefined, storedTipSlot: number | null): Promise<StoredMithrilAnchor | null> {
    if (!sink) return null;
    let bytes: Uint8Array | null;
    try { bytes = await sink.read(MITHRIL_ANCHOR_FILE); } catch { return null; }
    if (!bytes) return null;
    let a: StoredMithrilAnchor;
    try { a = JSON.parse(new TextDecoder().decode(bytes)) as StoredMithrilAnchor; } catch { return null; }
    if (!a || typeof a !== "object") return null;
    if (!Number.isInteger(a.slot) || a.slot < 0 || typeof a.hash !== "string" || !isHash32Hex(a.hash)) return null;
    if (storedTipSlot != null && a.slot > storedTipSlot) return null;
    return a;
}
