import { describe, expect, test } from "bun:test";
import { MemorySink } from "../src/node/chunkWriter";
import { LocalLedger, ledgerDiffName } from "../src/node/ledgerStore";
import type { LedgerBlockDiff, LedgerOut } from "../src/node/ledgerApply";
import { snapshotStateDigest, snapshotLooksValid, LEDGER_SNAPSHOT, type LedgerSnapshot } from "../src/node/ledgerSnapshot";
import { parseTablesMeta, scanMithrilTables, scanMithrilTablesStream, snapshotFromTables, snapshotFromTablesStream, verifyMithrilTablesFiles } from "../src/node/mithrilTables";
import { answerQuery } from "../src/node/query";
import { LocalChainIndex } from "../src/node/localIndex";
import { networkByName } from "../src/node/networks";
import { Address } from "@harmoniclabs/cardano-ledger-ts";
import { deriveEd25519PublicKey_sync, getEd25519Signature_sync, sha2_256_sync } from "@harmoniclabs/crypto";
import { ancillaryManifestHash, type AncillaryManifest } from "@harmoniclabs/mithril-ts";

const H = (c: string) => c.repeat(Math.ceil(64 / c.length)).slice(0, 64);
const out = (ref: string, slot: number, address = "addr_test1vr000000000000000000000000000000000000000000000000000000000000000000000000000"): LedgerOut => ({
    ref, txHash: ref.slice(0, 64), address, addressBytes: "", lovelace: "1000000", assets: [], createdSlot: slot, spentSlot: null,
});
const diff = (slot: number, hash: string, created: LedgerOut[], spent: string[] = [], unknownInputs: string[] = []): LedgerBlockDiff => ({
    format: 1, slot, hash, txs: created.length + spent.length, invalidTx: [], created, spent, unknownInputs,
});

function concat(...parts: Uint8Array[]): Uint8Array {
    const len = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

function toHexTest(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
}

/** bstr with the one/two-byte length prefix used by the tables map. */
function bstr(bytes: Uint8Array): Uint8Array {
    const n = bytes.length;
    if (n > 255) throw new Error("test bstr too long");
    return concat(new Uint8Array([0x58, n]), bytes);
}

function txin(txIdByte: number, txIx: number): Uint8Array {
    const key = new Uint8Array(34);
    key.fill(txIdByte, 0, 32);
    key[32] = txIx >> 8; key[33] = txIx & 0xff;
    return key;
}

/** tag0 TxOutCompact: CompactAddr base + AdaOnly 100 lovelace. */
function tag0(addr: Uint8Array, lovelace = 100): Uint8Array {
    return concat(new Uint8Array([0x00]), sbs(addr), new Uint8Array([0x00, lovelace]));
}

/** MemPack ShortByteString (VarLen MSB-first length; test lengths stay under 128). */
function sbs(bytes: Uint8Array): Uint8Array {
    if (bytes.length >= 128) throw new Error("test SBS too long");
    return concat(new Uint8Array([bytes.length]), bytes);
}

/** tag2 TxOut_AddrHash28_AdaOnly: key cred + 28B stake hash + 32B packed addr/network + 100 lovelace. */
function tag2(): Uint8Array {
    const addr28 = new Uint8Array(32);
    // packed: 3 LE words of payment hash (zero here), then the last word carries network/payment flags in its low bits.
    new DataView(addr28.buffer).setBigUint64(24, 1n, true); // payment key, testnet
    return concat(new Uint8Array([0x02, 0x01]), new Uint8Array(28), addr28, new Uint8Array([0x00, 100]));
}

/** tables = [1] + indefinite map of one key/value pair per entry. */
function tables(pairs: Array<[Uint8Array, Uint8Array]>): Uint8Array {
    const parts: Uint8Array[] = [new Uint8Array([0x81, 0xbf])];
    for (const [k, v] of pairs) parts.push(bstr(k), bstr(v));
    parts.push(new Uint8Array([0xff]));
    return concat(...parts);
}

const META = new TextEncoder().encode('{"backend":"utxohd-mem","checksum":1362250708,"tablesCodecVersion":1}');
const ADDR = "addr_test1vr000000000000000000000000000000000000000000000000000000000000000000000000000";
const ADDR_BYTES = new Uint8Array(57); // header 0 (base, testnet) + 28+28 zero hashes
const ADDR_STR = Address.fromBytes(ADDR_BYTES).toString();

describe("Mithril ancillary tables", () => {
    test("meta is a utxohd-mem v1 JSON; anything else is rejected", () => {
        expect(parseTablesMeta(META)).toEqual({ backend: "utxohd-mem", checksum: 1362250708, tablesCodecVersion: 1 });
        expect(parseTablesMeta(new TextEncoder().encode('{"backend":"utxohd-mem","checksum":1,"tablesCodecVersion":2}'))).toBeNull();
        expect(parseTablesMeta(new TextEncoder().encode('{"backend":"other","checksum":1,"tablesCodecVersion":1}'))).toBeNull();
        expect(parseTablesMeta(new Uint8Array([0x7b]))).toBeNull();
    });

    test("a signed ancillary manifest verifies the tables/meta SHA-256; a tampered table fails", () => {
        const seed = new Uint8Array(32); seed[0] = 7;
        const pub = deriveEd25519PublicKey_sync(seed);
        const vkeyRaw = toHexTest(new TextEncoder().encode(JSON.stringify([...pub])));
        const bytes = tables([[txin(9, 0), tag0(ADDR_BYTES)]]);
        const manifest: AncillaryManifest = { data: {
            [`ledger/42/tables`]: toHexTest(sha2_256_sync(bytes)),
            [`ledger/42/meta`]: toHexTest(sha2_256_sync(META)),
        }, signature: null };
        const hash = ancillaryManifestHash(manifest);
        const sig = getEd25519Signature_sync(hash, seed);
        manifest.signature = toHexTest(sig);
        const okV = verifyMithrilTablesFiles(bytes, META, JSON.stringify(manifest), 42, "preview", vkeyRaw);
        expect(okV.ok).toBe(true);
        expect(okV.signatureOk).toBe(true);
        expect(okV.tablesSha256).toBe(manifest.data["ledger/42/tables"]!);
        const tampered = bytes.slice(); tampered[10] = 1;
        const badV = verifyMithrilTablesFiles(tampered, META, JSON.stringify(manifest), 42, "preview", vkeyRaw);
        expect(badV.ok).toBe(false);
        expect(badV.errors.some((e) => e.includes("tables: sha256"))).toBe(true);
    });


    test("the streaming scanner matches the whole-file scanner across chunk boundaries", async () => {
        const tx0 = txin(11, 3);
        const bytes = tables([[tx0, tag0(ADDR_BYTES)]]);
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.subarray(i, Math.min(i + 3, bytes.length)));
        const scan = await scanMithrilTablesStream(chunks, { snapshotSlot: 100 });
        expect(scan.entries).toBe(1);
        expect(scan.decoded).toBe(1);
        expect(scan.errors).toBe(0);
        expect(scan.utxos[0]!.ref).toBe(`${"0b".repeat(32)}:3`);
    });


    test("the streaming snapshot builder produces the same UTxO-only base", async () => {
        const bytes = tables([[txin(12, 0), tag0(ADDR_BYTES)]]);
        const chunks = [bytes.subarray(0, 2), bytes.subarray(2, 9), bytes.subarray(9)];
        const { snapshot } = await snapshotFromTablesStream(chunks, META, 42, "preview");
        expect(snapshot.utxos).toHaveLength(1);
        expect(snapshot.historyComplete).toBe(false);
        expect(snapshot.stateDigest).toBe(snapshotStateDigest(snapshot.utxos));
    });


    test("the top-level envelope is [1] + indefinite map; key txid/txIx and the tag0/tag2 outputs decode", () => {
        const tx0 = txin(1, 3), tx1 = txin(2, 4);
        const bytes = tables([[tx0, tag0(ADDR_BYTES)], [tx1, tag2()]]);
        const scan = scanMithrilTables(bytes, { snapshotSlot: 100 });
        expect(scan.entries).toBe(2);
        expect(scan.decoded).toBe(2);
        expect(scan.errors).toBe(0);
        expect(scan.byTag).toEqual({ 0: 1, 2: 1 });
        expect(scan.utxos).toHaveLength(2);
        expect(scan.utxos[0]!.ref).toBe(`${"01".repeat(32)}:3`);
        expect(scan.utxos[0]!.address).toBe(ADDR_STR);
        expect(scan.utxos[0]!.lovelace).toBe("100");
        expect(scan.utxos[1]!.address).toBe(ADDR_STR);
        expect(scan.utxos[1]!.lovelace).toBe("100");
    });

    test("a malformed envelope is rejected; a malformed entry is counted, not fatal", () => {
        expect(() => scanMithrilTables(new Uint8Array([0x82, 0xbf, 0xff]))).toThrow("top level");
        const badKey = new Uint8Array(33); // not a 34-byte TxIn key
        const bad = tables([[badKey, tag0(ADDR_BYTES)]]);
        const scan = scanMithrilTables(bad, { snapshotSlot: 100 });
        expect(scan.entries).toBe(1);
        expect(scan.errors).toBe(1);
        expect(scan.decoded).toBe(0);
        expect(scan.firstError).toContain("entry 0");
    });

    test("snapshotFromTables is UTxO at a slot, not history: historyComplete false and startSlot = slot", () => {
        const tx0 = txin(4, 0);
        const bytes = tables([[tx0, tag0(ADDR_BYTES)]]);
        const { meta, snapshot } = snapshotFromTables(bytes, META, 42, "preview");
        expect(meta.backend).toBe("utxohd-mem");
        expect(snapshot.kind).toBe("snapshot");
        expect(snapshot.historyComplete).toBe(false);
        expect(snapshot.startSlot).toBe(42);
        expect(snapshot.slot).toBe(42);
        expect(snapshot.utxos).toHaveLength(1);
        expect(snapshot.stateDigest).toBe(snapshotStateDigest(snapshot.utxos));
        expect(snapshotLooksValid(snapshot, "preview")).toBe(true);
    });

    test("a tampered snapshot state digest is detectable before install", () => {
        const bytes = tables([[txin(5, 0), tag0(ADDR_BYTES)]]);
        const { snapshot } = snapshotFromTables(bytes, META, 50, "preview");
        snapshot.utxos[0]!.lovelace = "99";
        expect(snapshot.stateDigest).not.toBe(snapshotStateDigest(snapshot.utxos));
    });
});

describe("P1 snapshot install, resume and compaction", () => {
    test("installSnapshot persists a UTxO-only base; resume replays only diffs newer than the base", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        const bytes = tables([[txin(6, 0), tag0(ADDR_BYTES)]]);
        const { snapshot } = snapshotFromTables(bytes, META, 100, "preview");
        await ledger.installSnapshot(snapshot);
        expect(sink.files.has(LEDGER_SNAPSHOT)).toBe(true);
        expect(ledger.coverage.kind).toBe("snapshot");
        expect(ledger.coverage.startSlot).toBe(100);

        const resumed = new LocalLedger(sink, "preview");
        const s = await resumed.resume();
        expect(s.stale).toBe(false);
        expect(s.kind).toBe("snapshot");
        expect(s.startSlot).toBe(100);
        expect(s.tipSlot).toBe(100);
        expect(s.utxoCount).toBe(1);
        expect(resumed.historyComplete).toBe(false);
        expect(resumed.utxo(`${"06".repeat(32)}:0`)?.lovelace).toBe("100");
    });

    test("a rollback below a snapshot with no newer diffs still marks the base stale", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        const { snapshot } = snapshotFromTables(tables([[txin(13, 0), tag0(ADDR_BYTES)]]), META, 100, "preview");
        await ledger.installSnapshot(snapshot);
        expect(await ledger.rollbackTo(90)).toBe(0);
        expect(ledger.coverage.stale).toBe(true);
        expect(ledger.stats.lastError).toContain("below snapshot");
        const resumed = new LocalLedger(sink, "preview");
        const s = await resumed.resume();
        expect(s.stale).toBe(true);
    });


    test("a snapshot with a broken state digest resumes stale (the ledger refuses local answers)", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        const { snapshot } = snapshotFromTables(tables([[txin(7, 0), tag0(ADDR_BYTES)]]), META, 100, "preview");
        await ledger.installSnapshot(snapshot);
        const bad = JSON.parse(new TextDecoder().decode(sink.files.get(LEDGER_SNAPSHOT)!));
        bad.stateDigest = "00".repeat(32);
        sink.files.set(LEDGER_SNAPSHOT, new TextEncoder().encode(JSON.stringify(bad)));
        const resumed = new LocalLedger(sink, "preview");
        const s = await resumed.resume();
        expect(s.stale).toBe(true);
        expect(s.utxoCount).toBe(1);
    });

    test("address UTxOs can answer from an imported snapshot; tx-scoped answers refuse without history", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        const txHash = H("\u0008").toLowerCase();
        const { snapshot } = snapshotFromTables(tables([[txin(8, 0), tag0(ADDR_BYTES)]]), META, 100, "preview");
        await ledger.installSnapshot(snapshot);
        const ctx = { ledger, index: new LocalChainIndex(), network: networkByName("preview")! };
        let relayAsked = 0;
        const relay = async () => { relayAsked++; return { status: 200, body: JSON.stringify([{ relay: true }]) }; };

        const address = await answerQuery(`/addresses/${ADDR_STR}/utxos`, { ...ctx, relay });
        expect(address.source).toBe("local");
        expect(address.body).toHaveLength(1);
        expect(relayAsked).toBe(0);

        const tx = await answerQuery(`/txs/${txHash}/utxos`, { ...ctx, relay });
        expect(tx.source).toBe("relay");
        expect(relayAsked).toBe(1);
    });

    test("compactTo keeps the original coverage start and tombstones, drops older diffs, and a resume agrees", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        const aa = H("aa"), bb = H("bb"), cc = H("cc");
        await ledger.apply(new Uint8Array(0), 100, aa, diff(100, aa, [out(`${aa}:0`, 100)]));
        await ledger.apply(new Uint8Array(0), 101, bb, diff(101, bb, [out(`${bb}:0`, 101)], [`${aa}:0`]));
        await ledger.apply(new Uint8Array(0), 102, cc, diff(102, cc, [out(`${cc}:0`, 102)]));
        const removed = await ledger.compactTo(101);
        expect(removed).toBe(2);
        expect(sink.files.has(LEDGER_SNAPSHOT)).toBe(true);
        expect(sink.files.has(ledgerDiffName(100, aa))).toBe(false);
        expect(sink.files.has(ledgerDiffName(101, bb))).toBe(false);
        expect(sink.files.has(ledgerDiffName(102, cc))).toBe(true);
        expect(ledger.coverage.startSlot).toBe(100);
        expect(ledger.coverage.kind).toBe("verified-start");
        expect(ledger.txOutputs(aa)[0]!.spentSlot).toBe(101);

        const resumed = new LocalLedger(sink, "preview");
        const s = await resumed.resume();
        expect(s.stale).toBe(false);
        expect(s.startSlot).toBe(100);
        expect(s.tipSlot).toBe(102);
        expect(s.blocks).toBe(3);
        expect(s.created).toBe(3);
        expect(s.spent).toBe(1);
        expect(s.utxoCount).toBe(2);
        expect(resumed.txOutputs(aa)[0]!.spentSlot).toBe(101);
        expect(resumed.utxo(`${bb}:0`)?.spentSlot).toBeNull();
        expect(resumed.utxo(`${cc}:0`)?.lovelace).toBe("1000000");
    });

    test("a rollback across a compacted base stops at the snapshot and stays query-safe", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        const aa = H("aa"), bb = H("bb"), cc = H("cc");
        await ledger.apply(new Uint8Array(0), 100, aa, diff(100, aa, [out(`${aa}:0`, 100)]));
        await ledger.apply(new Uint8Array(0), 101, bb, diff(101, bb, [out(`${bb}:0`, 101)]));
        await ledger.apply(new Uint8Array(0), 102, cc, diff(102, cc, [out(`${cc}:0`, 102)]));
        await ledger.compactTo(101);
        expect(await ledger.rollbackTo(101)).toBe(1); // undo 102, not the snapshot base
        expect(ledger.coverage.tipSlot).toBe(101);
        expect(ledger.coverage.blocks).toBe(2);
        expect(ledger.utxo(`${aa}:0`)?.lovelace).toBe("1000000");
        expect(ledger.utxo(`${cc}:0`)).toBeNull();
        const resumed = new LocalLedger(sink, "preview");
        const s = await resumed.resume();
        expect(s.stale).toBe(false);
        expect(s.tipSlot).toBe(101);
        expect(s.startSlot).toBe(100);
    });
});
