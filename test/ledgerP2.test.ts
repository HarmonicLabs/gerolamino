import { describe, expect, test } from "bun:test";
import { LocalLedger } from "../src/node/ledgerStore";
import type { LedgerBlockDiff } from "../src/node/ledgerApply";

function diff(slot: number, fees: string, deposits: string, txHash: string): LedgerBlockDiff {
    return {
        format: 1, slot, hash: txHash, txs: 1, invalidTx: [],
        created: [{ ref: `${txHash}:0`, txHash, address: "addr_test1", addressBytes: "", lovelace: "2000000", assets: [], createdSlot: slot, spentSlot: null }],
        spent: [],
        unknownInputs: [],
        p2: { fees, deposits, withdrawals: "0", treasury: "0", donation: "0", minted: [], stakeRegistered: ["stake1"], stakeUnregistered: [], stakeDelegations: [["stake1", "pool1"]], poolRegistrations: ["pool1"], poolRetirements: [], governanceDeposits: ["100"] },
    };
}

describe("P2 ledger state", () => {
    test("fees, deposits and stake/gov counters persist through apply, compact and rollback", async () => {
        const ledger = new LocalLedger(null, "preview");
        await ledger.apply(new Uint8Array([1]), 1, "aa".repeat(32), diff(1, "100", "200", "aa".repeat(32)));
        expect(ledger.stats.p2Fees).toBe("100");
        expect(ledger.stats.p2Deposits).toBe("200");
        await ledger.apply(new Uint8Array([2]), 2, "bb".repeat(32), diff(2, "5", "6", "bb".repeat(32)));
        expect(ledger.stats.p2Fees).toBe("105");
        expect(ledger.stats.p2Deposits).toBe("206");
        await ledger.rollbackTo(1);
        expect(ledger.stats.p2Fees).toBe("100");
        expect(ledger.stats.p2Deposits).toBe("200");
        expect(ledger.stats.p2Donation).toBe("0");
        await ledger.apply(new Uint8Array([2]), 2, "bb".repeat(32), diff(2, "5", "6", "bb".repeat(32)));
        await ledger.compactTo(2);
        expect(ledger.stats.p2Fees).toBe("105");
    });
});
