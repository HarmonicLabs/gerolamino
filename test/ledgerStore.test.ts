import { describe, expect, test } from "bun:test";
import { MemorySink } from "../src/node/chunkWriter";
import { LocalLedger, ledgerDiffName } from "../src/node/ledgerStore";
import type { LedgerBlockDiff, LedgerOut } from "../src/node/ledgerApply";
import { BrowserNode } from "../src/node/browserNode";

const H = (c: string) => c.repeat(Math.ceil(64 / c.length)).slice(0, 64);
const out = (ref: string, slot: number, address = "addr_test1vr000000000000000000000000000000000000000000000000000000000000000000000000000"): LedgerOut => ({
    ref, txHash: ref.slice(0, 64), address, addressBytes: "", lovelace: "1000000", assets: [], createdSlot: slot, spentSlot: null,
});
const diff = (slot: number, hash: string, created: LedgerOut[], spent: string[] = [], unknownInputs: string[] = []): LedgerBlockDiff => ({
    format: 1, slot, hash, txs: created.length + spent.length, invalidTx: [], created, spent, unknownInputs,
});

describe("local UTxO diff log", () => {
    test("apply, spend, resume and tx outputs; a spent output stays as a tombstone", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        await ledger.apply(new Uint8Array(0), 100, H("aa"), diff(100, H("aa"), [out(H("aa") + ":0", 100)]));
        await ledger.apply(new Uint8Array(0), 101, H("bb"), diff(101, H("bb"), [], [H("aa") + ":0"]));
        expect(ledger.stats.created).toBe(1);
        expect(ledger.stats.spent).toBe(1);
        expect(ledger.stats.utxoCount).toBe(0);
        expect(ledger.txOutputs(H("aa"))[0]!.spentSlot).toBe(101);
        expect(ledger.utxo(H("aa") + ":0")).toBeNull();
        expect(sink.files.has(ledgerDiffName(100, H("aa")))).toBe(true);
        expect(sink.files.has("manifest.json")).toBe(true);

        const resumed = new LocalLedger(sink, "preview");
        const s = await resumed.resume();
        expect(s.utxoCount).toBe(0);
        expect(s.spent).toBe(1);
        expect(s.digest).toBe(ledger.stats.digest);
        expect(resumed.txOutputs(H("aa"))[0]!.spentSlot).toBe(101);
    });

    test("rollback deletes diffs, restores the spent output, and a resume agrees", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        await ledger.apply(new Uint8Array(0), 100, H("aa"), diff(100, H("aa"), [out(H("aa") + ":0", 100)]));
        await ledger.apply(new Uint8Array(0), 101, H("bb"), diff(101, H("bb"), [], [H("aa") + ":0"]));
        expect(await ledger.rollbackTo(100)).toBe(1);
        expect(ledger.stats.utxoCount).toBe(1);
        expect(ledger.utxo(H("aa") + ":0")?.spentSlot).toBeNull();
        expect(sink.files.has(ledgerDiffName(101, H("bb")))).toBe(false);
        const resumed = new LocalLedger(sink, "preview");
        const s = await resumed.resume();
        expect(s.utxoCount).toBe(1);
        expect(s.spent).toBe(0);
        expect(s.stale).toBe(false);
    });

    test("an unknown input is recorded, not fatal; a corrupt/tampered diff marks the ledger stale", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        await ledger.apply(new Uint8Array(0), 100, H("aa"), diff(100, H("aa"), [out(H("aa") + ":0", 100)]));
        await ledger.apply(new Uint8Array(0), 101, H("bb"), diff(101, H("bb"), [], [H("cc") + ":9"]));
        expect(ledger.stats.unknownInputs).toBe(1);
        expect(ledger.stats.created).toBe(1);

        sink.files.set(ledgerDiffName(101, H("bb")), new Uint8Array([0x7b])); // "{"
        const resumed = new LocalLedger(sink, "preview");
        const s = await resumed.resume();
        expect(s.stale).toBe(true);
        expect(s.utxoCount).toBe(1);
    });

    test("a torn manifest (missing block) is stale; digest chain continuity is checked", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        await ledger.apply(new Uint8Array(0), 100, H("aa"), diff(100, H("aa"), [out(H("aa") + ":0", 100)]));
        await ledger.apply(new Uint8Array(0), 101, H("bb"), diff(101, H("bb"), [], []));
        const manifest = JSON.parse(new TextDecoder().decode(sink.files.get("manifest.json")!));
        manifest.tipSlot = 102;
        sink.files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
        const resumed = new LocalLedger(sink, "preview");
        const s = await resumed.resume();
        expect(s.stale).toBe(true);
    });

    test("a repeated block is idempotent; the same slot on a new branch replaces the old diff", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        await ledger.apply(new Uint8Array(0), 100, H("aa"), diff(100, H("aa"), [out(H("aa") + ":0", 100)]));
        await ledger.apply(new Uint8Array(0), 100, H("aa"), diff(100, H("aa"), [out(H("aa") + ":0", 100)]));
        expect(ledger.stats.created).toBe(1);
        expect(ledger.stats.utxoCount).toBe(1);

        await ledger.apply(new Uint8Array(0), 100, H("dd"), diff(100, H("dd"), [out(H("dd") + ":0", 100)]));
        expect(ledger.stats.created).toBe(1);
        expect(ledger.stats.utxoCount).toBe(1);
        expect(ledger.utxo(H("aa") + ":0")).toBeNull();
        expect(ledger.utxo(H("dd") + ":0")).not.toBeNull();
        expect(ledger.stats.tipSlot).toBe(100);
        const resumed = new LocalLedger(sink, "preview");
        const s = await resumed.resume();
        expect(s.utxoCount).toBe(1);
        expect(resumed.utxo(H("dd") + ":0")).not.toBeNull();
        expect(s.stale).toBe(false);
    });

    test("without a sink the ledger still answers in memory (no persistence)", async () => {
        const ledger = new LocalLedger(undefined, "preview");
        await ledger.resume();
        await ledger.apply(new Uint8Array(0), 100, H("aa"), diff(100, H("aa"), [out(H("aa") + ":0", 100)]));
        expect(ledger.stats.utxoCount).toBe(1);
        expect(ledger.stats.blocks).toBe(1);
        expect(ledger.utxo(H("aa") + ":0")?.lovelace).toBe("1000000");
    });

    test("markStale persists the stale flag and stops promising a consistent replay", async () => {
        const sink = new MemorySink();
        const ledger = new LocalLedger(sink, "preview");
        await ledger.resume();
        await ledger.apply(new Uint8Array(0), 100, H("aa"), diff(100, H("aa"), [out(H("aa") + ":0", 100)]));
        await ledger.markStale("no block bytes for slot 101");
        expect(ledger.stats.stale).toBe(true);
        expect(ledger.stats.lastError).toContain("slot 101");
        const resumed = new LocalLedger(sink, "preview");
        const s = await resumed.resume();
        expect(s.stale).toBe(true);
        expect(s.utxoCount).toBe(1);
    });

    test("a BrowserNode reports its ledger counters from the constructor (before the first block)", async () => {
        const ledger = new LocalLedger(new MemorySink(), "preview");
        await ledger.resume();
        await ledger.apply(new Uint8Array(0), 100, H("aa"), diff(100, H("aa"), [out(H("aa") + ":0", 100)]));
        const node = new BrowserNode({ endpoint: "ws://x/n2n", networkMagic: 2, ledger });
        expect(node.stats.ledgerBlocks).toBe(1);
        expect(node.stats.ledgerUtxoCount).toBe(1);
        expect(node.stats.ledgerCoverageStart).toBe(100);
        expect(node.stats.ledgerError).toBeNull();
        expect(node.stats.ledgerStale).toBe(false);
    });
});
