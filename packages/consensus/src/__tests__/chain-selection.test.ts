import { describe, it, expect } from "vitest";
import { ChainTip, preferCandidate, gsmState } from "../chain-selection";

const makeTip = (slot: bigint, blockNo: bigint): ChainTip =>
  new ChainTip({ slot, blockNo, hash: new Uint8Array(32) });

describe("preferCandidate", () => {
  const k = 2160;

  it("prefers longer chain (higher blockNo)", () => {
    const ours = makeTip(100n, 50n);
    const candidate = makeTip(101n, 51n);
    expect(preferCandidate(ours, candidate, 1, k)).toBe(true);
  });

  it("rejects equal-length chain", () => {
    const ours = makeTip(100n, 50n);
    const candidate = makeTip(101n, 50n);
    expect(preferCandidate(ours, candidate, 1, k)).toBe(false);
  });

  it("rejects shorter chain", () => {
    const ours = makeTip(100n, 50n);
    const candidate = makeTip(99n, 49n);
    expect(preferCandidate(ours, candidate, 1, k)).toBe(false);
  });

  it("rejects fork deeper than k", () => {
    const ours = makeTip(100n, 50n);
    const candidate = makeTip(3000n, 100n);
    expect(preferCandidate(ours, candidate, k + 1, k)).toBe(false);
  });

  it("accepts fork at exactly k", () => {
    const ours = makeTip(100n, 50n);
    const candidate = makeTip(200n, 51n);
    expect(preferCandidate(ours, candidate, k, k)).toBe(true);
  });
});

describe("gsmState", () => {
  const stabilityWindow = 129600n; // 3k/f for mainnet (k=2160, f=0.05)

  it("returns CaughtUp when tip is within stability window of wallclock", () => {
    expect(gsmState(100000n, 100010n, stabilityWindow)).toBe("CaughtUp");
  });

  it("returns Syncing when tip is far behind wallclock", () => {
    expect(gsmState(100000n, 300000n, stabilityWindow)).toBe("Syncing");
  });

  it("returns CaughtUp at exact boundary", () => {
    expect(gsmState(0n, stabilityWindow, stabilityWindow)).toBe("CaughtUp");
  });

  it("returns Syncing one past boundary", () => {
    expect(gsmState(0n, stabilityWindow + 1n, stabilityWindow)).toBe("Syncing");
  });
});
