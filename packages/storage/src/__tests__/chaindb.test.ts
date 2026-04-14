/**
 * ChainDB XState machine tests — pure state transition logic.
 *
 * Tests use mock actors via .provide() so immutability promotion
 * and GC resolve immediately, matching the production code path.
 */
import { describe, it, expect } from "@effect/vitest";
import { createActor, fromPromise } from "xstate";
import { chainDBMachine } from "../machines/chaindb.ts";

/** Machine with mock actors that resolve immediately. */
const testMachine = chainDBMachine.provide({
  actors: {
    promoteBlocks: fromPromise<number, { tip: { slot: bigint; hash: Uint8Array } }>(
      async () => 1,
    ),
    collectGarbage: fromPromise<void, { belowSlot: bigint }>(async () => {}),
  },
});

describe("ChainDB Machine", () => {
  it("starts in idle state with correct context", () => {
    const actor = createActor(testMachine, { input: { securityParam: 10 } });
    actor.start();
    const snap = actor.getSnapshot();
    expect(snap.value).toEqual({
      blockProcessing: "idle",
      immutability: "idle",
    });
    expect(snap.context.securityParam).toBe(10);
    expect(snap.context.volatileLength).toBe(0);
    expect(snap.context.tip).toBeUndefined();
    actor.stop();
  });

  it("BLOCK_ADDED increments volatileLength and updates tip", () => {
    const actor = createActor(testMachine, { input: { securityParam: 10 } });
    actor.start();
    const tip = { slot: 1n, hash: new Uint8Array(32).fill(1) };
    actor.send({ type: "BLOCK_ADDED", tip });
    const snap = actor.getSnapshot();
    expect(snap.value.blockProcessing).toBe("idle");
    expect(snap.context.volatileLength).toBe(1);
    expect(snap.context.tip).toEqual(tip);
    actor.stop();
  });

  it("BLOCK_ADDED triggers IMMUTABILITY_CHECK when volatileLength > k", async () => {
    const actor = createActor(testMachine, { input: { securityParam: 2 } });
    actor.start();
    // Add 3 blocks to exceed k=2
    for (let i = 1; i <= 3; i++) {
      actor.send({
        type: "BLOCK_ADDED",
        tip: { slot: BigInt(i), hash: new Uint8Array(32).fill(i) },
      });
    }
    expect(actor.getSnapshot().context.volatileLength).toBe(3);
    // The raised IMMUTABILITY_CHECK triggers copying -> gc -> idle via mock actors.
    // Allow microtask resolution for the fromPromise actors.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(actor.getSnapshot().value.immutability).toBe("idle");
    // Mock promoteBlocks returns 1, so volatileLength decrements by 1 each cycle
    expect(actor.getSnapshot().context.volatileLength).toBeLessThan(3);
    actor.stop();
  });

  it("IMMUTABILITY_CHECK stays idle when volatileLength <= k", () => {
    const actor = createActor(testMachine, { input: { securityParam: 10 } });
    actor.start();
    actor.send({ type: "BLOCK_ADDED", tip: { slot: 1n, hash: new Uint8Array(32).fill(1) } });
    // BLOCK_ADDED raises IMMUTABILITY_CHECK internally, but k=10 > 1 block
    expect(actor.getSnapshot().value.immutability).toBe("idle");
    actor.stop();
  });

  it("ROLLBACK updates tip", () => {
    const actor = createActor(testMachine, { input: { securityParam: 10 } });
    actor.start();
    const rollbackPoint = { slot: 5n, hash: new Uint8Array(32).fill(5) };
    actor.send({ type: "ROLLBACK", point: rollbackPoint });
    expect(actor.getSnapshot().context.tip).toEqual(rollbackPoint);
    actor.stop();
  });

  it("ERROR captures error in context", () => {
    const actor = createActor(testMachine, { input: { securityParam: 10 } });
    actor.start();
    actor.send({ type: "ERROR", error: "test error" });
    expect(actor.getSnapshot().context.lastError).toBe("test error");
    actor.stop();
  });

  it("guard prevents IMMUTABILITY_CHECK when tip is undefined", () => {
    const actor = createActor(testMachine, { input: { securityParam: 0 } });
    actor.start();
    // Even with k=0 and volatileLength=0, guard rejects because tip is undefined
    actor.send({ type: "IMMUTABILITY_CHECK" });
    expect(actor.getSnapshot().value.immutability).toBe("idle");
    actor.stop();
  });
});
