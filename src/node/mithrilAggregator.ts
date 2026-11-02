/**
 * Mithril aggregator fallback for the browser: list/detail the cardano-database artifact, fetch the
 * ancillary `.tar.zst`, decompress it in pure TS (fzstd vendored in `zstd.ts`) and extract
 * `ledger/<slot>/{tables,meta}`. The caller verifies the signed manifest before using these bytes.
 */
import { Decompress } from "./zstd";
import { extractTarFiles } from "./tar";

export const MITHRIL_AGGREGATORS: Record<string, string> = {
    preview: "https://aggregator.pre-release-preview.api.mithril.network/aggregator",
    preprod: "https://aggregator.release-preprod.api.mithril.network/aggregator",
};

export interface AggregatorSnapshot {
    hash: string;
    merkle_root: string;
    certificate_hash: string;
    created_at: string;
    beacon: { epoch: number; immutable_file_number: number };
    ancillary?: { locations: Array<{ uri: string | { Template?: string; template?: string }; compression_algorithm?: string }>; size_uncompressed?: number };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function listMithrilSnapshots(network: string, fetchImpl: FetchLike = fetch, base = MITHRIL_AGGREGATORS[network]): Promise<AggregatorSnapshot[]> {
    if (!base) throw new Error(`no Mithril aggregator known for ${network}`);
    const res = await fetchImpl(`${base}/artifact/cardano-database`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Mithril aggregator list: HTTP ${res.status}`);
    const raw = await res.json() as unknown;
    if (!Array.isArray(raw)) throw new Error("Mithril aggregator list is not an array");
    return raw as AggregatorSnapshot[];
}

export async function getMithrilSnapshot(network: string, hash: string, fetchImpl: FetchLike = fetch, base = MITHRIL_AGGREGATORS[network]): Promise<AggregatorSnapshot> {
    if (!base) throw new Error(`no Mithril aggregator known for ${network}`);
    const res = await fetchImpl(`${base}/artifact/cardano-database/${hash}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Mithril aggregator detail: HTTP ${res.status}`);
    return await res.json() as AggregatorSnapshot;
}

export function ancillaryArchiveUrl(snapshot: AggregatorSnapshot): string | null {
    for (const loc of snapshot.ancillary?.locations ?? []) {
        const uri = typeof loc.uri === "string" ? loc.uri : loc.uri?.Template ?? loc.uri?.template ?? "";
        if (/^https?:/i.test(uri)) return uri;
    }
    return null;
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const n = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
}

/** One-shot zstd decompression; the archive is a single frame in practice. */
export function decompressZstd(bytes: Uint8Array): Uint8Array {
    const out: Uint8Array[] = [];
    const d = new (Decompress as any)((chunk: Uint8Array, final: boolean) => {
        if (chunk?.length) out.push(chunk);
        if (!final) return;
    });
    d.push(bytes, true);
    return concat(out);
}

/** Extract only the ledger files from an ancillary archive, matched to `slot`. */
export function extractLedgerFiles(tar: Uint8Array, slot: number): { tables: Uint8Array; meta: Uint8Array; manifest: Uint8Array | null; names: string[] } {
    const files = extractTarFiles(tar);
    const names = [...files.keys()];
    const pick = (name: string): Uint8Array | null => files.get(name) ?? files.get(name.replace(/^\.\//, "")) ?? null;
    const tables = pick(`ledger/${slot}/tables`);
    const meta = pick(`ledger/${slot}/meta`);
    if (!tables || !meta) throw new Error(`ancillary archive has no ledger/${slot}/{tables,meta}; entries: ${names.filter((n) => n.startsWith("ledger/")).slice(0, 8).join(", ")}`);
    const manifest = pick("ancillary_manifest.json");
    return { tables, meta, manifest, names };
}

export async function downloadAncillaryLedger(
    network: string,
    hash: string,
    slot: number,
    fetchImpl: FetchLike = fetch,
    log?: (line: string) => void,
    base = MITHRIL_AGGREGATORS[network],
): Promise<{ tables: Uint8Array; meta: Uint8Array; manifest: Uint8Array | null; url: string; bytes: number }> {
    const snap = await getMithrilSnapshot(network, hash, fetchImpl, base);
    const url = ancillaryArchiveUrl(snap);
    if (!url) throw new Error("the Mithril snapshot has no ancillary archive URL");
    log?.(`aggregator: downloading ancillary archive ${url}`);
    const res = await fetchImpl(url, { headers: { Accept: "application/octet-stream" } });
    if (!res.ok) throw new Error(`ancillary archive: HTTP ${res.status}`);
    const packed = new Uint8Array(await res.arrayBuffer());
    log?.(`aggregator: ${packed.length} bytes packed, decompressing…`);
    const tar = decompressZstd(packed);
    const { tables, meta, manifest } = extractLedgerFiles(tar, slot);
    log?.(`aggregator: extracted ledger/${slot}/{tables,meta} (${tables.length}/${meta.length} bytes)`);
    return { tables, meta, manifest, url, bytes: packed.length };
}
