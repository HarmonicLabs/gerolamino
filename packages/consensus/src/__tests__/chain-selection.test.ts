import { describe, it, expect } from "vitest";
import { ChainTip, preferCandidate, gsmState } from "../chain-selection";

const makeTip = (
  slot: bigint,
  blockNo: bigint,
  vrfOutput?: Uint8Array,
): ChainTip =>
  new ChainTip({ slot, blockNo, hash: new Uint8Array(32), vrfOutput });

describe("preferCandidate", () => {
  const k = 2160;

  // Rule 1: higher blockNo wins
  it("prefers longer chain (higher blockNo)", () => {
    expect(preferCandidate(makeTip(100n, 50n), makeTip(101n, 51n), 1, k)).toBe(true);
  });

  it("rejects shorter chain (lower blockNo)", () => {
    expect(preferCandidate(makeTip(100n, 50n), makeTip(99n, 49n), 1, k)).toBe(false);
  });

  // Rule 2: at equal blockNo, lower slot wins (denser)
  it("prefers denser chain (lower slot at equal blockNo)", () => {
    expect(preferCandidate(makeTip(200n, 50n), makeTip(100n, 50n), 1, k)).toBe(true);
  });

  it("rejects sparser chain (higher slot at equal blockNo)", () => {
    expect(preferCandidate(makeTip(100n, 50n), makeTip(200n, 50n), 1, k)).toBe(false);
  });

  // Rule 3: at equal slot + blockNo, lower VRF output wins
  it("prefers lower VRF output at equal slot and blockNo", () => {
    const vrfLow = new Uint8Array(32).fill(0x01);
    const vrfHigh = new Uint8Array(32).fill(0xff);
    expect(preferCandidate(makeTip(100n, 50n, vrfHigh), makeTip(100n, 50n, vrfLow), 1, k)).toBe(true);
  });

  it("rejects higher VRF output at equal slot and blockNo", () => {
    const vrfLow = new Uint8Array(32).fill(0x01);
    const vrfHigh = new Uint8Array(32).fill(0xff);
    expect(preferCandidate(makeTip(100n, 50n, vrfLow), makeTip(100n, 50n, vrfHigh), 1, k)).toBe(false);
  });

  it("sticks with current when VRF outputs are equal", () => {
    const vrf = new Uint8Array(32).fill(0x42);
    expect(preferCandidate(makeTip(100n, 50n, vrf), makeTip(100n, 50n, vrf), 1, k)).toBe(false);
  });

  // Rule 0: fork limit
  it("rejects fork deeper than k", () => {
    expect(preferCandidate(makeTip(100n, 50n), makeTip(3000n, 100n), k + 1, k)).toBe(false);
  });

  it("accepts fork at exactly k", () => {
    expect(preferCandidate(makeTip(100n, 50n), makeTip(200n, 51n), k, k)).toBe(true);
  });

  // Edge: no VRF output available
  it("sticks with current when no VRF outputs available", () => {
    expect(preferCandidate(makeTip(100n, 50n), makeTip(100n, 50n), 1, k)).toBe(false);
  });
});

describe("gsmState", () => {
  const stabilityWindow = 129600n; // 3k/f for mainnet

  it("returns CaughtUp when tip is within stability window", () => {
    expect(gsmState(100000n, 100010n, stabilityWindow)).toBe("CaughtUp");
  });

  it("returns Syncing when tip is far behind", () => {
    expect(gsmState(100000n, 300000n, stabilityWindow)).toBe("Syncing");
  });

  it("returns CaughtUp at exact boundary", () => {
    expect(gsmState(0n, stabilityWindow, stabilityWindow)).toBe("CaughtUp");
  });

  it("returns Syncing one past boundary", () => {
    expect(gsmState(0n, stabilityWindow + 1n, stabilityWindow)).toBe("Syncing");
  });
});
