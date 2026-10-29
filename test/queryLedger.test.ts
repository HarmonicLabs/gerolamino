import { describe, expect, test } from "bun:test";
import { MemorySink } from "../src/node/chunkWriter";
import { LocalLedger } from "../src/node/ledgerStore";
import type { LedgerBlockDiff, LedgerOut } from "../src/node/ledgerApply";
import { LocalChainIndex } from "../src/node/localIndex";
import { answerQuery } from "../src/node/query";
import { networkByName } from "../src/node/networks";

const H = (c: string) => c.repeat(Math.ceil(64 / c.length)).slice(0, 64);
const ADDR = "addr_test1vr000000000000000000000000000000000000000000000000000000000000000000000000000";
const out = (ref: string, slot: number): LedgerOut => ({
    ref, txHash: ref.slice(0, 64), address: ADDR, addressBytes: "", lovelace: "1000000", assets: [], createdSlot: slot, spentSlot: null,
});
const diff = (slot: number, hash: string, created: LedgerOut[], spent: string[] = []): LedgerBlockDiff => ({
    format: 1, slot, hash, txs: created.length + spent.length, invalidTx: [], created, spent, unknownInputs: [],
});

/** A ledger with one created output; `/txs/{hash}/utxos` and `/utxo/{ref}` are complete from that slot. */
async function ledgerWithOutput(slot: number): Promise<LocalLedger> {
    const ledger = new LocalLedger(new MemorySink(), "preview");
    await ledger.resume();
    const txHash = H("aa");
    await ledger.apply(new Uint8Array(0), slot, H("bb"), diff(slot, H("bb"), [out(txHash + ":0", slot)]));
    return ledger;
}

describe("ledger-backed queries carry coverage and never invent UTxO", () => {
    test("tx outputs and an unspent UTxO answer from the local ledger, with where the answer is complete from", async () => {
        const network = networkByName("preview")!;
        const ledger = await ledgerWithOutput(100);
        const txHash = H("aa");
        const ctx = { ledger, index: new LocalChainIndex(), network };
        let relayAsked = 0;
        const relay = async () => { relayAsked++; return { status: 200, body: "{}" }; };

        const tx = await answerQuery(`/txs/${txHash}/utxos`, { ...ctx, relay });
        expect(tx.source).toBe("local");
        expect(tx.ledger).toEqual({ startSlot: 100, kind: "verified-start", tipSlot: 100 });
        const outs = tx.body as Array<Record<string, unknown>>;
        expect(outs).toHaveLength(1);
        expect(outs[0]).toMatchObject({ tx_hash: txHash, output_index: 0, address: ADDR, spent_boolean: false });
        expect(outs[0]!.amount).toEqual([{ unit: "lovelace", quantity: "1000000" }]);
        expect(relayAsked).toBe(0);

        const utxo = await answerQuery(`/utxo/${txHash}:0`, { ...ctx, relay });
        expect(utxo.source).toBe("local");
        expect(utxo.body).toMatchObject({ tx_hash: txHash, output_index: 0, address: ADDR, spent_boolean: false });
        expect(utxo.ledger).toMatchObject({ startSlot: 100 });
        expect(relayAsked).toBe(0);
    });

    test("a spent output stays visible on its tx (spent_boolean true), while /utxo falls through to the relay", async () => {
        const network = networkByName("preview")!;
        const ledger = await ledgerWithOutput(100);
        const txHash = H("aa");
        await ledger.apply(new Uint8Array(0), 101, H("cc"), diff(101, H("cc"), [], [txHash + ":0"]));
        const ctx = { ledger, index: new LocalChainIndex(), network };
        let relayAsked = 0;
        const relay = async () => { relayAsked++; return { status: 200, body: JSON.stringify([{ relay: true }]) }; };

        const tx = await answerQuery(`/txs/${txHash}/utxos`, { ...ctx, relay });
        expect(tx.source).toBe("local");
        expect((tx.body as any[])[0]!.spent_boolean).toBe(true);
        expect(tx.ledger!.tipSlot).toBe(101);

        const utxo = await answerQuery(`/utxo/${txHash}:0`, { ...ctx, relay });
        expect(utxo.source).toBe("relay");
        expect(utxo.body).toEqual([{ relay: true }]);
        expect(relayAsked).toBe(1);
    });

    test("address UTxOs answer locally only from genesis/snapshot coverage; from a later verified start they go to the relay", async () => {
        const network = networkByName("preview")!;
        const partial = await ledgerWithOutput(100);
        let relayAsked = 0;
        const relay = async () => { relayAsked++; return { status: 200, body: "peer" }; };
        const fromRelay = await answerQuery(`/addresses/${ADDR}/utxos`, { ledger: partial, index: new LocalChainIndex(), network, relay });
        expect(fromRelay.source).toBe("relay");
        expect(relayAsked).toBe(1);

        const genesis = await ledgerWithOutput(0);
        const local = await answerQuery(`/addresses/addr_test1vr_empty/utxos`, { ledger: genesis, index: new LocalChainIndex(), network, relay });
        expect(local.source).toBe("local");
        expect(local.body).toEqual([]);
        expect(local.ledger).toMatchObject({ startSlot: 0 });
        expect(relayAsked).toBe(1); // the partial-coverage answer only
    });

    test("a stale ledger refuses local answers (the relay sees the path)", async () => {
        const network = networkByName("preview")!;
        const ledger = await ledgerWithOutput(100);
        await ledger.markStale("decode gap");
        const txHash = H("aa");
        let relayAsked = 0;
        const relay = async () => { relayAsked++; return { status: 200, body: "peer" }; };
        const tx = await answerQuery(`/txs/${txHash}/utxos`, { ledger, index: new LocalChainIndex(), network, relay });
        expect(tx.source).toBe("relay");
        expect(relayAsked).toBe(1);
        expect(ledger.stats.stale).toBe(true);
    });
});
