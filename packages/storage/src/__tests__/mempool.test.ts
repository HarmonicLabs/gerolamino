/**
 * Mempool XState machine tests — pure state transition logic.
 */
import { describe, test, expect } from "bun:test";
import { createActor } from "xstate";
import { mempoolMachine } from "../machines/mempool.ts";
import type { MempoolTx } from "../types/Mempool.ts";

const makeTx = (id: number, size: number): MempoolTx => ({
  txId: new Uint8Array(32).fill(id),
  txCbor: new Uint8Array(size),
  txSizeBytes: size,
  addedAt: id,
});

describe("Mempool Machine", () => {
  test("starts in accepting state with empty txs", () => {
    const actor = createActor(mempoolMachine, { input: { maxBytes: 10000 } });
    actor.start();
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("accepting");
    expect(snap.context.txs.length).toBe(0);
    expect(snap.context.totalBytes).toBe(0);
    actor.stop();
  });

  test("accepts transactions when under capacity", () => {
    const actor = createActor(mempoolMachine, { input: { maxBytes: 10000 } });
    actor.start();
    actor.send({ type: "TX_SUBMITTED", tx: makeTx(1, 500) });
    expect(actor.getSnapshot().context.txs.length).toBe(1);
    expect(actor.getSnapshot().context.totalBytes).toBe(500);

    actor.send({ type: "TX_SUBMITTED", tx: makeTx(2, 300) });
    expect(actor.getSnapshot().context.txs.length).toBe(2);
    expect(actor.getSnapshot().context.totalBytes).toBe(800);
    actor.stop();
  });

  test("rejects transactions when at capacity", () => {
    const actor = createActor(mempoolMachine, { input: { maxBytes: 1000 } });
    actor.start();
    actor.send({ type: "TX_SUBMITTED", tx: makeTx(1, 800) });
    expect(actor.getSnapshot().context.txs.length).toBe(1);

    // This should be rejected (800 + 500 > 1000)
    actor.send({ type: "TX_SUBMITTED", tx: makeTx(2, 500) });
    expect(actor.getSnapshot().context.txs.length).toBe(1); // still 1
    expect(actor.getSnapshot().context.totalBytes).toBe(800);
    actor.stop();
  });

  test("removes transactions on BLOCK_APPLIED", () => {
    const actor = createActor(mempoolMachine, { input: { maxBytes: 10000 } });
    actor.start();
    actor.send({ type: "TX_SUBMITTED", tx: makeTx(1, 100) });
    actor.send({ type: "TX_SUBMITTED", tx: makeTx(2, 200) });
    actor.send({ type: "TX_SUBMITTED", tx: makeTx(3, 300) });
    expect(actor.getSnapshot().context.txs.length).toBe(3);

    // Remove tx 2 (included in block)
    const tx2Id = new Uint8Array(32).fill(2);
    actor.send({ type: "BLOCK_APPLIED", txIds: [tx2Id] });
    expect(actor.getSnapshot().context.txs.length).toBe(2);
    expect(actor.getSnapshot().context.totalBytes).toBe(400); // 100 + 300
    actor.stop();
  });

  test("increments snapshotNo on each state change", () => {
    const actor = createActor(mempoolMachine, { input: { maxBytes: 10000 } });
    actor.start();
    expect(actor.getSnapshot().context.snapshotNo).toBe(0);

    actor.send({ type: "TX_SUBMITTED", tx: makeTx(1, 100) });
    expect(actor.getSnapshot().context.snapshotNo).toBe(1);

    actor.send({ type: "TX_SUBMITTED", tx: makeTx(2, 100) });
    expect(actor.getSnapshot().context.snapshotNo).toBe(2);

    actor.send({ type: "BLOCK_APPLIED", txIds: [new Uint8Array(32).fill(1)] });
    expect(actor.getSnapshot().context.snapshotNo).toBe(3);
    actor.stop();
  });
});
