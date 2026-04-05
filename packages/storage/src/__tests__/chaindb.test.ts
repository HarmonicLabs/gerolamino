/**
 * ChainDB XState machine tests — pure state transition logic.
 */
import { describe, it, expect } from "@effect/vitest";
import { createActor } from "xstate";
import { chainDBMachine } from "../machines/chaindb.ts";

const makeBlock = (slot: bigint, blockNo: bigint) => ({
  slot,
  hash: new Uint8Array(32).fill(Number(slot % 256n)),
  prevHash: slot > 0n ? new Uint8Array(32).fill(Number((slot - 1n) % 256n)) : undefined,
  blockNo,
  blockSizeBytes: 1000,
  blockCbor: new Uint8Array(100),
});

describe("ChainDB Machine", () => {
  it("starts in idle state with correct context", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 10 } });
    actor.start();
    const snap = actor.getSnapshot();
    expect(snap.value).toEqual({
      blockProcessing: "idle",
      immutability: "idle",
      snapshotting: "idle",
    });
    expect(snap.context.securityParam).toBe(10);
    expect(snap.context.volatileLength).toBe(0);
    expect(snap.context.tip).toBeUndefined();
    actor.stop();
  });

  it("transitions to received on BLOCK_RECEIVED, increments volatileLength", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 10 } });
    actor.start();
    actor.send({ type: "BLOCK_RECEIVED", block: makeBlock(1n, 1n) });
    const snap = actor.getSnapshot();
    expect(snap.value.blockProcessing).toBe("received");
    expect(snap.context.volatileLength).toBe(1);
    actor.stop();
  });

  it("transitions back to idle on CHAIN_SELECTED, updates tip", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 10 } });
    actor.start();
    actor.send({ type: "BLOCK_RECEIVED", block: makeBlock(1n, 1n) });
    const tip = { slot: 1n, hash: new Uint8Array(32).fill(1) };
    actor.send({ type: "CHAIN_SELECTED", tip });
    const snap = actor.getSnapshot();
    expect(snap.value.blockProcessing).toBe("idle");
    expect(snap.context.tip).toEqual(tip);
    actor.stop();
  });

  it("IMMUTABILITY_CHECK transitions to copying when volatileLength > k", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 2 } });
    actor.start();
    // Add 3 blocks to exceed k=2
    for (let i = 1; i <= 3; i++) {
      actor.send({ type: "BLOCK_RECEIVED", block: makeBlock(BigInt(i), BigInt(i)) });
      actor.send({
        type: "CHAIN_SELECTED",
        tip: { slot: BigInt(i), hash: new Uint8Array(32).fill(i) },
      });
    }
    expect(actor.getSnapshot().context.volatileLength).toBe(3);
    actor.send({ type: "IMMUTABILITY_CHECK" });
    expect(actor.getSnapshot().value.immutability).toBe("copying");
    actor.stop();
  });

  it("IMMUTABILITY_CHECK stays idle when volatileLength <= k", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 10 } });
    actor.start();
    actor.send({ type: "BLOCK_RECEIVED", block: makeBlock(1n, 1n) });
    actor.send({ type: "CHAIN_SELECTED", tip: { slot: 1n, hash: new Uint8Array(32).fill(1) } });
    actor.send({ type: "IMMUTABILITY_CHECK" });
    expect(actor.getSnapshot().value.immutability).toBe("idle");
    actor.stop();
  });

  it("full immutability cycle: copying -> gc -> idle", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 1 } });
    actor.start();
    actor.send({ type: "BLOCK_RECEIVED", block: makeBlock(1n, 1n) });
    actor.send({ type: "CHAIN_SELECTED", tip: { slot: 1n, hash: new Uint8Array(32).fill(1) } });
    actor.send({ type: "BLOCK_RECEIVED", block: makeBlock(2n, 2n) });
    actor.send({ type: "CHAIN_SELECTED", tip: { slot: 2n, hash: new Uint8Array(32).fill(2) } });
    expect(actor.getSnapshot().context.volatileLength).toBe(2);

    actor.send({ type: "IMMUTABILITY_CHECK" });
    expect(actor.getSnapshot().value.immutability).toBe("copying");

    actor.send({ type: "COPY_COMPLETE" });
    expect(actor.getSnapshot().value.immutability).toBe("gc");

    actor.send({ type: "GC_COMPLETE" });
    expect(actor.getSnapshot().value.immutability).toBe("idle");
    expect(actor.getSnapshot().context.volatileLength).toBe(1);
    actor.stop();
  });

  it("ROLLBACK updates tip", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 10 } });
    actor.start();
    const rollbackPoint = { slot: 5n, hash: new Uint8Array(32).fill(5) };
    actor.send({ type: "ROLLBACK", point: rollbackPoint });
    expect(actor.getSnapshot().context.tip).toEqual(rollbackPoint);
    actor.stop();
  });

  it("ERROR captures error in context", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 10 } });
    actor.start();
    actor.send({ type: "ERROR", error: "test error" });
    expect(actor.getSnapshot().context.lastError).toBe("test error");
    actor.stop();
  });
});
