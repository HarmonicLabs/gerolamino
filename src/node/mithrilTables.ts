/**
 * Mithril ancillary UTxO tables (`utxohd-mem`, tablesCodecVersion 1) reader and snapshot builder.
 *
 * The ancillary `tables` file is CBOR `[1]` followed by an indefinite map of
 * `bstr(TxIn MemPack) -> bstr(TxOut MemPack)`. TxIn is 32-byte txid || 16-bit BE txIx; TxOut uses
 * the Babbage compact variants 0-5. This module decodes the entries and turns every fully-consumed
 * output into the local ledger's `LedgerOut` row. It does not verify the ancillary manifest or the
 * file checksum by itself: callers must verify those before installing the resulting snapshot.
 */
import { blake2b_224 } from "@harmoniclabs/crypto";
import { Address, Script } from "@harmoniclabs/cardano-ledger-ts";
import { toHex, fromHex } from "@harmoniclabs/uint8array-utils";
import { ANCILLARY_VKEYS, parseAncillaryManifest, verifyAncillaryManifestSignature, type AncillaryManifest } from "@harmoniclabs/mithril-ts";
import { decodeUtxoEntry, type TxOutDecoded, type CompactValueDecoded, type MultiAssetTriple } from "./utxohdMemCodec";
import { sha256Hex } from "./sha256";
import { snapshotStateDigest, type LedgerSnapshot } from "./ledgerSnapshot";
import type { LedgerAsset, LedgerOut } from "./ledgerApply";

export interface TablesMeta {
    backend: string;
    checksum: number;
    tablesCodecVersion: number;
}

export interface TablesVerification {
    ok: boolean;
    manifest: AncillaryManifest | null;
    signatureOk: boolean;
    tablesSha256: string | null;
    metaSha256: string | null;
    errors: string[];
}

export interface TablesScan {
    entries: number;
    decoded: number;
    skipped: number;
    errors: number;
    byTag: Record<number, number>;
    utxos: LedgerOut[];
    firstError: string | null;
}

/** Reused across a scan: bech32 address strings by raw-address hex (millions of outputs share far fewer addresses). */
type AddressCache = Map<string, string | null>;

export interface ImportMithrilTablesResult {
    meta: TablesMeta;
    snapshot: LedgerSnapshot;
    entries: number;
    decoded: number;
    skipped: number;
    errors: number;
    byTag: Record<number, number>;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a); out.set(b, a.length); return out;
}

interface CborHdr { major: number; ai: number; len: number | null; next: number }

/** Minimal CBOR header reader for the two definite byte strings and the indefinite map. */
function readHdr(buf: Uint8Array, off: number): CborHdr | null {
    if (off >= buf.length) return null;
    const b = buf[off]!;
    const major = b >> 5, ai = b & 0x1f;
    let pos = off + 1, len: number | null = null;
    if (ai < 24) len = ai;
    else if (ai === 24) { if (pos >= buf.length) return null; len = buf[pos++]!; }
    else if (ai === 25) { if (pos + 2 > buf.length) return null; len = (buf[pos]! << 8) | buf[pos + 1]!; pos += 2; }
    else if (ai === 26) {
        if (pos + 4 > buf.length) return null;
        len = ((buf[pos]! << 24) | (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!) >>> 0;
        pos += 4;
    } else if (ai === 27) {
        if (pos + 8 > buf.length) return null;
        const hi = ((buf[pos]! << 24) | (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!) >>> 0;
        const lo = ((buf[pos + 4]! << 24) | (buf[pos + 5]! << 16) | (buf[pos + 6]! << 8) | buf[pos + 7]!) >>> 0;
        pos += 8;
        len = hi * 2 ** 32 + lo;
    } else if (ai === 31) len = null;
    else return null;
    return { major, ai, len, next: pos };
}

/** Verify a `tables`/`meta` pair against an unpacked Mithril `ancillary_manifest.json`.
 *  The manifest is signed by the network's ancillary Ed25519 key; each file's SHA-256 must match its entry. */
export function verifyMithrilTablesFiles(tables: Uint8Array, meta: Uint8Array, manifestJson: string, slot: number, network: string, vkeyRaw?: string): TablesVerification {
    const errors: string[] = [];
    let manifest: AncillaryManifest | null = null;
    try { manifest = parseAncillaryManifest(manifestJson); } catch (e) { errors.push(`manifest: ${(e as Error).message}`); }
    const sigKey = vkeyRaw ?? ANCILLARY_VKEYS[network];
    const signatureOk = manifest && sigKey ? verifyAncillaryManifestSignature(manifest, sigKey) : false;
    if (!signatureOk) errors.push(sigKey ? "manifest signature does not verify against the ancillary key" : `no ancillary verification key for ${network}`);
    const lookup = (kind: "tables" | "meta"): string | null => {
        if (!manifest) return null;
        const hit = Object.keys(manifest.data).find((k) => k.endsWith(`${slot}/${kind}`));
        if (!hit) { errors.push(`manifest has no ledger/${slot}/${kind}`); return null; }
        return manifest.data[hit]!;
    };
    const tablesExpected = lookup("tables"), metaExpected = lookup("meta");
    const tablesSha256 = tablesExpected ? sha256Hex(tables) : null;
    const metaSha256 = metaExpected ? sha256Hex(meta) : null;
    if (tablesExpected && tablesSha256 !== tablesExpected) errors.push(`tables: sha256 ${tablesSha256} differs from the manifest's ${tablesExpected}`);
    if (metaExpected && metaSha256 !== metaExpected) errors.push(`meta: sha256 ${metaSha256} differs from the manifest's ${metaExpected}`);
    return { ok: errors.length === 0, manifest, signatureOk, tablesSha256, metaSha256, errors };
}

/** Parse the ancillary `meta` file (`utxohd-mem` only). */
export function parseTablesMeta(bytes: Uint8Array): TablesMeta | null {
    let meta: unknown;
    try { meta = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
    if (!meta || typeof meta !== "object") return null;
    const m = meta as Record<string, unknown>;
    if (m.backend !== "utxohd-mem" || m.tablesCodecVersion !== 1 || typeof m.checksum !== "number") return null;
    return { backend: m.backend, checksum: m.checksum, tablesCodecVersion: m.tablesCodecVersion };
}

/** Scan the CBOR entry stream without copying the file. `limit` is for smoke tests, not production. */
export function scanMithrilTables(bytes: Uint8Array, opts: { limit?: number; snapshotSlot?: number } = {}): TablesScan {
    const limit = opts.limit;
    const snapshotSlot = opts.snapshotSlot ?? 0;
    const result: TablesScan = { entries: 0, decoded: 0, skipped: 0, errors: 0, byTag: {}, utxos: [], firstError: null };
    const addressCache: AddressCache = new Map();
    if (bytes.length === 0) return result;
    const top = readHdr(bytes, 0);
    if (!top || top.major !== 4 || top.len !== 1) throw new Error("tables: top level is not [1]");
    const map = readHdr(bytes, top.next);
    if (!map || map.major !== 5) throw new Error("tables: top level is not an indefinite map");
    let off = map.next;
    while (limit == null || result.entries < limit) {
        const kH = readHdr(bytes, off);
        if (!kH) break;
        if (kH.major === 7 && kH.ai === 31) break;
        if (kH.major !== 2 || kH.len == null || kH.len < 0) throw new Error(`tables: key at entry ${result.entries} is not a definite bstr`);
        const keyStart = kH.next, keyEnd = keyStart + kH.len;
        const vH = readHdr(bytes, keyEnd);
        if (!vH || vH.major !== 2 || vH.len == null || vH.len < 0) throw new Error(`tables: value at entry ${result.entries} is not a definite bstr`);
        const valStart = vH.next, valEnd = valStart + vH.len;
        if (valEnd > bytes.length) throw new Error(`tables: truncated at entry ${result.entries}`);
        const dec = decodeUtxoEntry(bytes.subarray(keyStart, keyEnd), bytes.subarray(valStart, valEnd));
        result.entries++;
        if (!dec.ok) {
            result.errors += 1;
            if (result.firstError == null) result.firstError = `entry ${result.entries - 1}: ${dec.error} @${dec.off}`;
        } else {
            result.byTag[dec.value.txOut.tag] = (result.byTag[dec.value.txOut.tag] ?? 0) + 1;
            const out = outFromTables(dec.value.txIn.txIdHex, dec.value.txIn.txIx, dec.value.txOut, snapshotSlot, addressCache);
            if (out) { result.utxos.push(out); result.decoded += 1; }
            else result.skipped += 1;
        }
        off = valEnd;
    }
    return result;
}

/** A byte source over chunks; no whole-file buffering (the `tables` file is ~650 MB on preview). */
class ChunkCursor {
    private chunk: Uint8Array | null = null;
    private pos = 0;
    private it: AsyncIterator<Uint8Array>;
    private done = false;
    bytesRead = 0;
    constructor(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) { this.it = (Symbol.asyncIterator in chunks ? (chunks as AsyncIterable<Uint8Array>) : (async function* gen(c: Iterable<Uint8Array>) { yield* c; })(chunks as Iterable<Uint8Array>))[Symbol.asyncIterator](); }
    private avail(): number { return this.chunk ? this.chunk.length - this.pos : 0; }
    private async pull(): Promise<boolean> {
        if (this.done) return false;
        for (;;) {
            const r = await this.it.next();
            if (r.done) { this.done = true; this.chunk = null; return false; }
            const c = r.value;
            if (c && c.length) { this.chunk = c; this.pos = 0; return true; }
        }
    }
    async need(n: number): Promise<boolean> {
        while (this.avail() < n) {
            const chunk = this.chunk, pos = this.pos;
            const rest = chunk && pos < chunk.length ? chunk.subarray(pos) : null;
            if (!(await this.pull())) return false;
            if (rest && rest.length) {
                const joined = new Uint8Array(rest.length + this.chunk!.length);
                joined.set(rest, 0); joined.set(this.chunk!, rest.length);
                this.chunk = joined; this.pos = 0;
            }
        }
        return true;
    }
    async bytes(n: number): Promise<Uint8Array | null> {
        if (!(await this.need(n))) return null;
        const out = this.chunk!.slice(this.pos, this.pos + n);
        this.pos += n; this.bytesRead += n;
        return out;
    }
    async byte(): Promise<number | null> {
        const b = await this.bytes(1);
        return b ? b[0]! : null;
    }
    async skip(n: number): Promise<boolean> { return (await this.bytes(n)) !== null; }
    async return(): Promise<void> { try { await this.it.return?.(); } catch { /* ignore */ } }
}

/** Streaming variant: decode the same envelope from chunks so the ~650 MB file never has to fit in memory. */
export async function scanMithrilTablesStream(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, opts: { limit?: number; snapshotSlot?: number; decode?: boolean } = {}): Promise<TablesScan> {
    const cur = new ChunkCursor(source);
    const result: TablesScan = { entries: 0, decoded: 0, skipped: 0, errors: 0, byTag: {}, utxos: [], firstError: null };
    const addressCache: AddressCache = new Map();
    const decode = opts.decode !== false;
    const top = await cur.byte();
    if (top === null) return result;
    if (top !== 0x81) throw new Error("tables: top level is not [1]");
    const map = await cur.byte();
    if (map !== 0xbf) throw new Error("tables: top level is not an indefinite map");
    while (opts.limit == null || result.entries < opts.limit) {
        const keyHead = await cur.byte();
        if (keyHead === null) break;
        if (keyHead === 0xff) break;
        if (keyHead >> 5 !== 2) throw new Error(`tables: key at entry ${result.entries} is not a definite bstr`);
        const keyLen = await readLen(cur, keyHead & 0x1f, () => { throw new Error(`tables: bad key length at entry ${result.entries}`); });
        const key = await cur.bytes(keyLen);
        if (!key) throw new Error(`tables: truncated key at entry ${result.entries}`);
        const valHead = await cur.byte();
        if (valHead === null || valHead >> 5 !== 2) throw new Error(`tables: value at entry ${result.entries} is not a definite bstr`);
        const valLen = await readLen(cur, valHead & 0x1f, () => { throw new Error(`tables: bad value length at entry ${result.entries}`); });
        const val = await cur.bytes(valLen);
        if (!val) throw new Error(`tables: truncated value at entry ${result.entries}`);
        if (!decode) { result.entries++; continue; }
        const dec = decodeUtxoEntry(key, val);
        result.entries++;
        if (!dec.ok) {
            result.errors += 1;
            if (result.firstError == null) result.firstError = `entry ${result.entries - 1}: ${dec.error} @${dec.off}`;
        } else {
            result.byTag[dec.value.txOut.tag] = (result.byTag[dec.value.txOut.tag] ?? 0) + 1;
            const o = outFromTables(dec.value.txIn.txIdHex, dec.value.txIn.txIx, dec.value.txOut, opts.snapshotSlot ?? 0, addressCache);
            if (o) { result.utxos.push(o); result.decoded += 1; } else result.skipped += 1;
        }
    }
    await cur.return();
    return result;
}

async function readLen(cur: ChunkCursor, ai: number, fail: () => never): Promise<number> {
    if (ai < 24) return ai;
    if (ai === 24) { const b = await cur.byte(); if (b === null) throw new Error("tables: truncated bstr length"); return b; }
    if (ai === 25) { const b = await cur.bytes(2); if (!b) throw new Error("tables: truncated bstr length"); return (b[0]! << 8) | b[1]!; }
    if (ai === 26) { const b = await cur.bytes(4); if (!b) throw new Error("tables: truncated bstr length"); return (((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0); }
    if (ai === 27) { const b = await cur.bytes(8); if (!b) throw new Error("tables: truncated bstr length"); return (((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0) * 2 ** 32 + (((b[4]! << 24) | (b[5]! << 16) | (b[6]! << 8) | b[7]!) >>> 0); }
    return fail();
}


function snapshotResult(scan: TablesScan, meta: TablesMeta, slot: number, network: string): ImportMithrilTablesResult {
    const utxos = scan.utxos;
    const stateDigest = snapshotStateDigest(utxos);
    const snapshot: LedgerSnapshot = {
        format: 1,
        network,
        startSlot: slot,
        kind: "snapshot",
        slot,
        digest: stateDigest,
        stateDigest,
        blocks: 0,
        created: utxos.length,
        spent: 0,
        unknownInputs: 0,
        invalidTx: 0,
        historyComplete: false,
        utxos,
        at: Date.now(),
    };
    return { meta, snapshot, entries: scan.entries, decoded: scan.decoded, skipped: scan.skipped, errors: scan.errors, byTag: scan.byTag };
}

export function snapshotFromTables(bytes: Uint8Array, metaBytes: Uint8Array, slot: number, network: string, opts: { limit?: number } = {}): ImportMithrilTablesResult {
    const meta = parseTablesMeta(metaBytes);
    if (!meta) throw new Error("tables: meta is not utxohd-mem tablesCodecVersion 1");
    if (!Number.isInteger(slot) || slot < 0) throw new Error("tables: bad snapshot slot");
    return snapshotResult(scanMithrilTables(bytes, { limit: opts.limit, snapshotSlot: slot }), meta, slot, network);
}

/** Streaming import: the same snapshot from chunks; the `tables` buffer stays out of memory. */
export async function snapshotFromTablesStream(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, metaBytes: Uint8Array, slot: number, network: string, opts: { limit?: number } = {}): Promise<ImportMithrilTablesResult> {
    const meta = parseTablesMeta(metaBytes);
    if (!meta) throw new Error("tables: meta is not utxohd-mem tablesCodecVersion 1");
    if (!Number.isInteger(slot) || slot < 0) throw new Error("tables: bad snapshot slot");
    return snapshotResult(await scanMithrilTablesStream(chunks, { limit: opts.limit, snapshotSlot: slot }), meta, slot, network);
}

function assetsFromTriples(assets: MultiAssetTriple[]): LedgerAsset[] {
    return assets.map((a) => ({ policy: a.policyIdHex, name: a.assetNameHex, quantity: a.quantity.toString() }));
}

function lovelaceOf(value: CompactValueDecoded): string {
    return value.lovelace.toString();
}

/** The staking credential (last 28 bytes) of a base address; enterprise/pointer have none in a base address. */
function stakeKeyOfRawAddress(raw: Uint8Array | null): string | undefined {
    if (!raw || raw.length !== 57) return undefined;
    const type = raw[0]! >> 4;
    if (type > 3) return undefined;
    let hex = "";
    for (let i = 29; i < 57; i++) hex += raw[i]!.toString(16).padStart(2, "0");
    return (type === 2 || type === 3 ? "01" : "") + hex;
}

/** Rebuild the 57-byte base address for the Addr28Extra compact forms (tag 2/3). */
function addr28ToRaw(txOut: Extract<TxOutDecoded, { tag: 2 | 3 }>): Uint8Array {
    if (txOut.addr28.length !== 32) throw new Error(`addr28 length ${txOut.addr28.length}`);
    const a28 = txOut.addr28;
    const v = new DataView(a28.buffer, a28.byteOffset, 32);
    const w0 = v.getBigUint64(0, true);
    const w1 = v.getBigUint64(8, true);
    const w2 = v.getBigUint64(16, true);
    const w3 = v.getBigUint64(24, true);
    const networkMain = (w3 & 2n) !== 0n;
    const paymentKey = (w3 & 1n) !== 0n;
    const pay = new Uint8Array(28);
    const pv = new DataView(pay.buffer);
    pv.setBigUint64(0, w0, false);
    pv.setBigUint64(8, w1, false);
    pv.setBigUint64(16, w2, false);
    pv.setUint32(24, Number(w3 >> 32n) >>> 0, false);
    const stake = fromHex(txOut.payHashHex);
    if (stake.length !== 28) throw new Error(`stake hash length ${stake.length}`);
    let header = 0;
    if (networkMain) header |= 1;
    if (!paymentKey) header |= 1 << 4;
    if (txOut.stakeCred === "script") header |= 1 << 5;
    const raw = new Uint8Array(57);
    raw[0] = header;
    raw.set(pay, 1);
    raw.set(stake, 29);
    return raw;
}

function scriptRefHashOf(txOut: Extract<TxOutDecoded, { tag: 5 }>): string | undefined {
    const s = txOut.script;
    if (s.kind === "native") {
        // Script.native wants a NativeScript object; the ledger hash prefix rule is 0x00 || script bytes.
        return toHex(blake2b_224(concat(new Uint8Array([0]), s.bytes)));
    }
    const script = s.language === 0 ? Script.plutusV1(s.bytes)
        : s.language === 1 ? Script.plutusV2(s.bytes)
            : s.language === 2 ? Script.plutusV3(s.bytes)
                : s.language === 3 ? Script.plutusV4(s.bytes) : null;
    if (!script) return undefined;
    return script.hash.toString();
}

/** One fully-decoded tables entry → the local ledger's UTxO row. Returns null when the output is incomplete or
 *  the address cannot be rebuilt. */
export function outFromTables(txHash: string, txIx: number, txOut: TxOutDecoded, snapshotSlot: number, addressCache?: Map<string, string | null>): LedgerOut | null {
    let raw: Uint8Array | null = null;
    let datumHash: string | undefined;
    let inlineDatum: string | undefined;
    let scriptRefHash: string | undefined;
    let lovelace = "0";
    let assets: LedgerAsset[] = [];

    if (txOut.tag === 0 || txOut.tag === 1 || txOut.tag === 4 || txOut.tag === 5) {
        if (!txOut.fullyConsumed || !txOut.addrRaw) return null;
        raw = txOut.addrRaw;
        lovelace = lovelaceOf(txOut.value);
        if (txOut.value.kind === "multiAsset" && txOut.value.repFullyDecoded) assets = assetsFromTriples(txOut.value.assets);
        if (txOut.tag === 1) datumHash = txOut.dataHashHex;
        else if (txOut.tag === 4) inlineDatum = toHex(txOut.inlineDatum);
        else if (txOut.tag === 5) {
            if (txOut.datum.kind === "datumHash") datumHash = txOut.datum.hashHex;
            else if (txOut.datum.kind === "inline") inlineDatum = toHex(txOut.datum.bytes);
            scriptRefHash = scriptRefHashOf(txOut);
        }
    } else if (txOut.tag === 2 || txOut.tag === 3) {
        if (!txOut.fullyConsumed) return null;
        raw = addr28ToRaw(txOut);
        lovelace = txOut.lovelace.toString();
        if (txOut.tag === 3) datumHash = txOut.dataHash32Hex;
    } else {
        return null;
    }
    if (!raw || raw.length === 0) return null;
    const rawHex = toHex(raw);
    let address = addressCache?.get(rawHex);
    if (address === undefined) {
        try { address = Address.fromBytes(raw).toString(); } catch { address = null; }
        if (addressCache) addressCache.set(rawHex, address);
    }
    if (address === null) return null;
    const hash = txHash.toLowerCase();
    const stakeKey = stakeKeyOfRawAddress(raw);
    return {
        ref: `${hash}:${txIx}`,
        txHash: hash,
        address,
        addressBytes: rawHex,
        lovelace,
        assets,
        ...(datumHash ? { datumHash } : {}),
        ...(inlineDatum ? { inlineDatum } : {}),
        ...(scriptRefHash ? { scriptRefHash } : {}),
        ...(stakeKey ? { stakeKey } : {}),
        createdSlot: snapshotSlot,
        spentSlot: null,
    };
}
