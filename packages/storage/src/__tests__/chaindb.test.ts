/**
 * ChainDB reducer tests — pure state transitions on `ChainDBState`.
 *
 * The lifecycle used to be an XState parallel-region machine; it's now
 * a plain `reduce(state, event)` fold driven by a `SubscriptionRef` +
 * `Queue<ChainDBEvent>` inside `chain-db-live.ts`. These tests exercise
 * the reducer directly — no actor lifecycle, no async, just function
 * equality.
 */
import { describe, it, expect } from "@effect/vitest";
import { initialChainDBState, reduce } from "../machines/chaindb.ts";

const mkTip = (slot: number, fill: number) => ({
  slot: BigInt(slot),
  hash: new Uint8Array(32).fill(fill),
});

describe("ChainDB reducer", () => {
  it("initial state has idle immutability + zero volatile length", () => {
    const s = initialChainDBState(10);
    expect(s.immutability).toBe("idle");
    expect(s.securityParam).toBe(10);
    expect(s.volatileLength).toBe(0);
    expect(s.tip).toBeUndefined();
    expect(s.immutableTip).toBeUndefined();
    expect(s.lastError).toBeUndefined();
  });

  it("BlockAdded increments volatileLength and updates tip", () => {
    const tip = mkTip(1, 1);
    const s1 = reduce(initialChainDBState(10), { _tag: "BlockAdded", tip });
    expect(s1.volatileLength).toBe(1);
    expect(s1.tip).toEqual(tip);
    expect(s1.immutability).toBe("idle");
  });

  it("BlockAdded past k transitions immutability to copying; PromoteDone → gc", () => {
    const seq = [1, 2, 3].map((i) => mkTip(i, i));
    const sCopying = seq.reduce(
      (s, tip) => reduce(s, { _tag: "BlockAdded", tip }),
      initialChainDBState(2),
    );
    expect(sCopying.volatileLength).toBe(3);
    expect(sCopying.immutability).toBe("copying");

    const sGc = reduce(sCopying, { _tag: "PromoteDone", promoted: 1 });
    expect(sGc.immutability).toBe("gc");
    expect(sGc.volatileLength).toBe(2);
    expect(sGc.immutableTip).toEqual(mkTip(3, 3));

    const sIdle = reduce(sGc, { _tag: "GcDone" });
    expect(sIdle.immutability).toBe("idle");
  });

  it("PromoteFailed returns to idle and records lastError", () => {
    const seq = [1, 2, 3].map((i) => mkTip(i, i));
    const sCopying = seq.reduce(
      (s, tip) => reduce(s, { _tag: "BlockAdded", tip }),
      initialChainDBState(2),
    );
    const s = reduce(sCopying, { _tag: "PromoteFailed", error: "boom" });
    expect(s.immutability).toBe("idle");
    expect(s.lastError).toBe("boom");
  });

  it("GcFailed returns to idle and records lastError", () => {
    const seq = [1, 2, 3].map((i) => mkTip(i, i));
    const sGc = reduce(
      seq.reduce((s, tip) => reduce(s, { _tag: "BlockAdded", tip }), initialChainDBState(2)),
      { _tag: "PromoteDone", promoted: 1 },
    );
    const s = reduce(sGc, { _tag: "GcFailed", error: "gc boom" });
    expect(s.immutability).toBe("idle");
    expect(s.lastError).toBe("gc boom");
  });

  it("volatileLength <= k keeps immutability idle", () => {
    const s = reduce(initialChainDBState(10), { _tag: "BlockAdded", tip: mkTip(1, 1) });
    expect(s.immutability).toBe("idle");
  });

  it("Rollback updates tip without touching immutability", () => {
    const point = mkTip(5, 5);
    const s = reduce(initialChainDBState(10), { _tag: "Rollback", point });
    expect(s.tip).toEqual(point);
    expect(s.immutability).toBe("idle");
  });

  it("ErrorRaised captures error in state", () => {
    const s = reduce(initialChainDBState(10), { _tag: "ErrorRaised", error: "test error" });
    expect(s.lastError).toBe("test error");
  });

  it("transitions are pure — same input yields same output", () => {
    const tip = mkTip(1, 1);
    const s0 = initialChainDBState(10);
    const a = reduce(s0, { _tag: "BlockAdded", tip });
    const b = reduce(s0, { _tag: "BlockAdded", tip });
    expect(a).toEqual(b);
    // Input state must not mutate.
    expect(s0.volatileLength).toBe(0);
    expect(s0.tip).toBeUndefined();
  });
});
