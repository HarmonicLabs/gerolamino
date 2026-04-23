/**
 * ChainDB XState machine tests — pure state transition logic.
 *
 * The machine is effect-free: `copying` and `gc` states wait for
 * externally-fired completion events (PROMOTE_DONE/FAILED, GC_DONE/FAILED)
 * so tests drive the lifecycle by sending those events explicitly.
 */
import { describe, it, expect } from "@effect/vitest";
import { createActor } from "xstate";
import { chainDBMachine } from "../machines/chaindb.ts";

describe("ChainDB Machine", () => {
  it("starts in idle state with correct context", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 10 } });
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
    const actor = createActor(chainDBMachine, { input: { securityParam: 10 } });
    actor.start();
    const tip = { slot: 1n, hash: new Uint8Array(32).fill(1) };
    actor.send({ type: "BLOCK_ADDED", tip });
    const snap = actor.getSnapshot();
    expect(snap.value.blockProcessing).toBe("idle");
    expect(snap.context.volatileLength).toBe(1);
    expect(snap.context.tip).toEqual(tip);
    actor.stop();
  });

  it("BLOCK_ADDED past k transitions immutability to copying and waits for PROMOTE_DONE", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 2 } });
    actor.start();
    for (let i = 1; i <= 3; i++) {
      actor.send({
        type: "BLOCK_ADDED",
        tip: { slot: BigInt(i), hash: new Uint8Array(32).fill(i) },
      });
    }
    expect(actor.getSnapshot().context.volatileLength).toBe(3);
    expect(actor.getSnapshot().value.immutability).toBe("copying");

    actor.send({ type: "PROMOTE_DONE", promoted: 1 });
    expect(actor.getSnapshot().value.immutability).toBe("gc");
    expect(actor.getSnapshot().context.volatileLength).toBe(2);
    expect(actor.getSnapshot().context.immutableTip).toEqual({
      slot: 3n,
      hash: new Uint8Array(32).fill(3),
    });

    actor.send({ type: "GC_DONE" });
    expect(actor.getSnapshot().value.immutability).toBe("idle");
    actor.stop();
  });

  it("PROMOTE_FAILED returns to idle and records lastError", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 2 } });
    actor.start();
    for (let i = 1; i <= 3; i++) {
      actor.send({
        type: "BLOCK_ADDED",
        tip: { slot: BigInt(i), hash: new Uint8Array(32).fill(i) },
      });
    }
    expect(actor.getSnapshot().value.immutability).toBe("copying");
    actor.send({ type: "PROMOTE_FAILED", error: "boom" });
    expect(actor.getSnapshot().value.immutability).toBe("idle");
    expect(actor.getSnapshot().context.lastError).toBe("boom");
    actor.stop();
  });

  it("GC_FAILED returns to idle and records lastError", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 2 } });
    actor.start();
    for (let i = 1; i <= 3; i++) {
      actor.send({
        type: "BLOCK_ADDED",
        tip: { slot: BigInt(i), hash: new Uint8Array(32).fill(i) },
      });
    }
    actor.send({ type: "PROMOTE_DONE", promoted: 1 });
    expect(actor.getSnapshot().value.immutability).toBe("gc");
    actor.send({ type: "GC_FAILED", error: "gc boom" });
    expect(actor.getSnapshot().value.immutability).toBe("idle");
    expect(actor.getSnapshot().context.lastError).toBe("gc boom");
    actor.stop();
  });

  it("IMMUTABILITY_CHECK stays idle when volatileLength <= k", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 10 } });
    actor.start();
    actor.send({ type: "BLOCK_ADDED", tip: { slot: 1n, hash: new Uint8Array(32).fill(1) } });
    expect(actor.getSnapshot().value.immutability).toBe("idle");
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

  it("guard prevents IMMUTABILITY_CHECK when tip is undefined", () => {
    const actor = createActor(chainDBMachine, { input: { securityParam: 0 } });
    actor.start();
    actor.send({ type: "IMMUTABILITY_CHECK" });
    expect(actor.getSnapshot().value.immutability).toBe("idle");
    actor.stop();
  });
});
