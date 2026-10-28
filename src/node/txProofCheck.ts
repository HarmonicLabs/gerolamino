/**
 * Checking a relayed answer about a transaction against Mithril (pure, unit tested). The peer answers
 * `/txs/{hash}…` from its ledger; Mithril's proof says whether that transaction is on the chain and in which block
 * range. An answer whose block height lies outside the certified range, or a transaction Mithril does not know
 * although its block is old enough to be certified, means the peer is wrong.
 */
export type TxProofStatus = "certified" | "too-new" | "mismatch" | "unavailable";

export interface TxProofCheck {
    status: TxProofStatus;
    detail: string;
    certificate?: string;
    blockRange?: { start: number; end: number };
    latestBlockNumber?: number;
}

/** What the check needs of a verified Mithril proof (@harmoniclabs/mithril-ts mithrilTxProof). */
export interface TxProofView {
    certificateHash: string;
    latestBlockNumber: number;
    certified: Map<string, { start: number; end: number }>;
}

/** The transaction a path is about (lower-case hex), or null for other paths. */
export function txHashOfPath(path: string): string | null {
    const m = /^\/txs\/([0-9a-fA-F]{64})(?:\/[a-z_]+)?$/.exec(path);
    return m ? m[1]!.toLowerCase() : null;
}

export function checkTxAnswer(txHash: string, body: unknown, proof: TxProofView | null, error?: string): TxProofCheck {
    if (!proof) return { status: "unavailable", detail: error ? `Mithril: ${error}` : "no Mithril proof" };
    const height = body && typeof body === "object" && typeof (body as any).block_height === "number" ? (body as any).block_height as number : null;
    const base = { certificate: proof.certificateHash, latestBlockNumber: proof.latestBlockNumber };
    const range = proof.certified.get(txHash);
    if (range) {
        if (height != null && (height < range.start || height >= range.end)) {
            return { ...base, status: "mismatch", blockRange: range, detail: `the peer says block ${height}; Mithril certifies it in blocks ${range.start} to ${range.end - 1}` };
        }
        return { ...base, status: "certified", blockRange: range, detail: `on the chain in blocks ${range.start} to ${range.end - 1}, certified by Mithril` };
    }
    if (height == null || height > proof.latestBlockNumber) {
        return { ...base, status: "too-new", detail: `newer than Mithril's latest certified block ${proof.latestBlockNumber}` };
    }
    return { ...base, status: "mismatch", detail: `the peer says block ${height}, but Mithril, certified up to block ${proof.latestBlockNumber}, does not know this transaction` };
}
