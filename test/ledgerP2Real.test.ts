import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fromHex, toHex } from "@harmoniclabs/uint8array-utils";
import { MultiEraBlock } from "@harmoniclabs/cardano-ledger-ts";
import { ledgerDiffFromBlock } from "../src/node/ledgerApply";
import { LocalLedger } from "../src/node/ledgerStore";
import { snapshotStateDigest, p2StateDigest } from "../src/node/ledgerSnapshot";

/** A real preview block by absolute slot and the hash the fixture names it with. */
function blockFixture(slot: number): { bytes: Uint8Array; hash: string } {
    const bytes = fromHex(readFileSync(new URL(`./fixtures/preview-block-${slot}.hex`, import.meta.url), "utf8").trim());
    return { bytes, hash: toHex(new Uint8Array(32).fill(slot & 0xff)) };
}

describe("P2 ledger state from real preview blocks", () => {
    test("fees and deposits replay without false failures; snapshot round-trips", async () => {
        const b1 = blockFixture(10703285);
        const b2 = blockFixture(12925989);
        const d1 = ledgerDiffFromBlock(b1.bytes, 10703285, b1.hash);
        const d2 = ledgerDiffFromBlock(b2.bytes, 12925989, b2.hash);
        for (const [bytes, slot, hash, d] of [[b1.bytes, 10703285, b1.hash, d1], [b2.bytes, 12925989, b2.hash, d2]] as const) {
            const m: any = MultiEraBlock.fromCbor(bytes);
            const bodies: any[] = Array.isArray(m.block?.transactionBodies) ? m.block.transactionBodies : [];
            const fees = bodies.reduce((n, b) => n + BigInt(String(b.fee?.toString?.() ?? 0)), 0n);
            expect(d.txs).toBe(bodies.length);
            expect(BigInt(d.p2!.fees)).toBe(fees);
            expect(BigInt(d.p2!.deposits)).toBe(2_000_000n * BigInt(d.p2!.stakeRegistered.length + d.p2!.poolRegistrations.length));
            expect(d.unknownInputs.length).toBeLessThanOrEqual(d.spent.length);
        }
        const ledger = new LocalLedger(null, "preview");
        await ledger.apply(b1.bytes, 10703285, b1.hash, d1);
        await ledger.apply(b2.bytes, 12925989, b2.hash, d2);
        const expectedFees = BigInt(d1.p2!.fees) + BigInt(d2.p2!.fees);
        expect(BigInt(ledger.stats.p2Fees)).toBe(expectedFees);
        expect(BigInt(ledger.stats.p2Deposits)).toBe(2_000_000n * BigInt(d1.p2!.stakeRegistered.length + d1.p2!.poolRegistrations.length) + 2_000_000n * BigInt(d2.p2!.stakeRegistered.length + d2.p2!.poolRegistrations.length));

        expect(await ledger.rollbackTo(10703285)).toBe(1);
        expect(BigInt(ledger.stats.p2Fees)).toBe(BigInt(d1.p2!.fees));
        await ledger.apply(b2.bytes, 12925989, b2.hash, d2);
        const removed = await ledger.compactTo(12925989);
        expect(removed).toBe(2); // both diffs fold into the snapshot
        const snap: any = (ledger as any).snapshot;
        expect(snap.slot).toBe(12925989);
        expect(snap.stateDigest).toBe(snapshotStateDigest(snap.utxos));
        expect(snap.p2Digest).toBe(p2StateDigest(snap.p2));

        const resumed = new LocalLedger(null, "preview");
        await resumed.installSnapshot(snap);
        expect(BigInt(resumed.stats.p2Fees)).toBe(expectedFees);
        expect(BigInt(resumed.stats.p2Deposits)).toBe(BigInt(ledger.stats.p2Deposits));
        expect(resumed.stats.blocks).toBe(2);
        expect(resumed.coverage.utxoCount).toBe(ledger.coverage.utxoCount);
    });

    test("Conway proposal deposits replay without a false failure", async () => {
        const b = blockFixture(64848165);
        const d = ledgerDiffFromBlock(b.bytes, 64848165, b.hash);
        expect(d.txs).toBe(1);
        expect(d.p2!.governanceDeposits.length).toBe(5);
        expect(d.p2!.governanceDeposits.every((x) => BigInt(x) === 100_000_000_000n)).toBe(true);
        expect(d.p2!.deposits).toBe("0");
        const ledger = new LocalLedger(null, "preview");
        await ledger.apply(b.bytes, 64848165, b.hash, d);
        expect(BigInt(ledger.stats.p2Fees)).toBe(298821n);
    });
});
