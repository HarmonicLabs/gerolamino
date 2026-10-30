#!/usr/bin/env bun
/**
 * P1 smoke: import a Mithril ancillary `tables` file into the Gerolamino local ledger, then prove the
 * UTxO answers it can give and the answers it refuses. No chain is synced; this is the snapshot path on its
 * own. The tables hold the UTxO set at a slot, not the spent history before it, so the snapshot says
 * `historyComplete: false` and `/txs/{hash}/utxos` is not promised locally.
 *
 *   bun scripts/mithril-tables-smoke.ts --tables <dir>/tables --meta <dir>/meta --slot <slot>
 *       [--network preview] [--limit 20000] [--persist <dir>]
 *
 * A real preview `tables` file is ~621 MB; `--limit` keeps the smoke fast and still imports real rows.
 */
import { readFileSync } from "node:fs";
import { MemorySink } from "../src/node/chunkWriter";
import { OpfsSink } from "../src/node/opfsSink";
import { LocalLedger } from "../src/node/ledgerStore";
import { scanMithrilTables, scanMithrilTablesStream, snapshotFromTables, snapshotFromTablesStream, verifyMithrilTablesFiles } from "../src/node/mithrilTables";
import { answerQuery } from "../src/node/query";
import { LocalChainIndex } from "../src/node/localIndex";
import { networkByName } from "../src/node/networks";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const tablesPath = arg("tables") ?? "";
const metaPath = arg("meta") ?? "";
const manifestPath = arg("manifest");
const slot = Number(arg("slot", "0"));
const network = arg("network", "preview") as "preview" | "preprod";
const limitArg = arg("limit");
const limit = limitArg != null ? Number(limitArg) : undefined;
const scanOnly = process.argv.includes("--scan-only");
const countOnly = process.argv.includes("--count-only");
const streamInput = process.argv.includes("--stream");
if (!tablesPath || !metaPath) { console.error("usage: --tables <file> --meta <file> --slot <slot>"); process.exit(2); }
const net = networkByName(network);
if (!net) { console.error(`unknown network ${network}`); process.exit(2); }
if (!Number.isInteger(slot) || slot <= 0) { console.error("--slot must be a positive integer"); process.exit(2); }

const t0 = Date.now();
const tables = new Uint8Array(readFileSync(tablesPath));
const meta = new Uint8Array(readFileSync(metaPath));
const manifestJson = manifestPath ? new TextDecoder().decode(new Uint8Array(readFileSync(manifestPath))) : null;
const verification = manifestJson ? verifyMithrilTablesFiles(tables, meta, manifestJson, slot, network) : null;
if (verification && !verification.ok) {
    console.log(JSON.stringify({ manifest: manifestPath, verification }, null, 2));
    process.exit(1);
}
if (countOnly) {
    const scan = await scanMithrilTablesStream(Bun.file(tablesPath).stream() as unknown as AsyncIterable<Uint8Array>, { limit, snapshotSlot: slot, decode: false });
    console.log(JSON.stringify({ tablesPath, metaPath, network, slot, limit: limit ?? "full", tablesBytes: tables.length, entries: scan.entries, byTag: scan.byTag }, null, 2));
    process.exit(scan.entries > 0 ? 0 : 1);
}
let imported: ReturnType<typeof snapshotFromTables> | null = null;
if (!scanOnly) imported = streamInput
    ? await snapshotFromTablesStream(Bun.file(tablesPath).stream() as unknown as AsyncIterable<Uint8Array>, meta, slot, network, { limit })
    : snapshotFromTables(tables, meta, slot, network, { limit });
if (scanOnly) {
    const scan = streamInput
        ? await scanMithrilTablesStream(Bun.file(tablesPath).stream() as unknown as AsyncIterable<Uint8Array>, { limit, snapshotSlot: slot })
        : scanMithrilTables(tables, { limit, snapshotSlot: slot });
    console.log(JSON.stringify({
        tablesPath, metaPath, network, slot, limit: limit ?? "full", tablesBytes: tables.length,
        manifestVerified: verification?.ok ?? false,
        entries: scan.entries, decoded: scan.decoded, skipped: scan.skipped, errors: scan.errors, byTag: scan.byTag,
    }, null, 2));
    process.exit(scan.errors === 0 && scan.decoded > 0 ? 0 : 1);
}
const importResult = imported!;
const importMs = Date.now() - t0;
const sink = new MemorySink();
const ledger = new LocalLedger(sink, network);
await ledger.installSnapshot(importResult.snapshot, { verifyStateDigest: false });
const stats = ledger.stats;
const first = importResult.snapshot.utxos[0] ?? null;
const ctx = { ledger, index: new LocalChainIndex(), network: net };

let utxoAnswer: unknown = null, addressAnswer: unknown = null, txAnswerSource: string | null = null;
if (first) {
    const u = await answerQuery(`/utxo/${first.ref}`, ctx);
    utxoAnswer = u.source === "local" ? u.body : null;
    const a = await answerQuery(`/addresses/${first.address}/utxos`, ctx);
    addressAnswer = a.source === "local" ? a.body : null;
    const t = await answerQuery(`/txs/${first.txHash}/utxos`, { ...ctx, relay: async () => ({ status: 200, body: "[]" }) });
    txAnswerSource = t.source;
}
const persisted = arg("persist", undefined);
if (persisted) {
    const dir = persisted!;
    const disk = new OpfsSink(dir);
    await disk.write("snapshot.json", new Uint8Array(new TextEncoder().encode(JSON.stringify(importResult.snapshot))));
    await disk.write("manifest.json", sink.files.get("manifest.json")!);
    const files = await disk.list();
    console.log(JSON.stringify({ persisted: dir, files: files.length, snapshotBytes: sink.files.get("snapshot.json")!.length, manifestBytes: sink.files.get("manifest.json")!.length }));
}
const summary = {
    tablesPath, metaPath, network, slot, limit: limit ?? "full",
    tablesBytes: tables.length, importMs,
    meta: { backend: importResult.meta.backend, checksum: importResult.meta.checksum, tablesCodecVersion: importResult.meta.tablesCodecVersion },
    manifestVerified: verification?.ok ?? false, manifestSignatureOk: verification?.signatureOk ?? false,
    tablesSha256: verification?.tablesSha256 ?? null,
    entries: importResult.entries, decoded: importResult.decoded, skipped: importResult.skipped, errors: importResult.errors, byTag: importResult.byTag,
    snapshotDigest: importResult.snapshot.digest, snapshotStateDigest: importResult.snapshot.stateDigest,
    historyComplete: importResult.snapshot.historyComplete, startSlot: importResult.snapshot.startSlot,
    ledgerBlocks: stats.blocks, ledgerUtxoCount: stats.utxoCount, ledgerCreated: stats.created, ledgerSpent: stats.spent,
    ledgerCoverageStart: stats.startSlot, ledgerStale: stats.stale, ledgerKind: stats.kind,
    firstRef: first?.ref ?? null, firstAddress: first?.address ?? null, firstTxHash: first?.txHash ?? null,
    utxoAnswer, addressAnswerCount: Array.isArray(addressAnswer) ? addressAnswer.length : null, txAnswerSource,
    ledgerFiles: sink.files.size, ledgerBytes: sink.bytes,
};
console.log(JSON.stringify(summary, null, 2));
const ok = importResult.errors === 0 && importResult.decoded > 0 && stats.utxoCount === importResult.decoded && !stats.stale && !!first &&
    utxoAnswer != null && Array.isArray(addressAnswer) && addressAnswer.length > 0 && txAnswerSource === "relay";
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
