import { describe, it, expect } from "@effect/vitest";
import { ChainTip, preferCandidate, gsmState } from "../chain/selection";

const makeTip = (slot: bigint, blockNo: bigint, vrfOutput?: Uint8Array): ChainTip =>
  new ChainTip({ slot, blockNo, hash: new Uint8Array(32), vrfOutput });

describe("preferCandidate", () => {
  const k = 2160;

  // Rule 1: higher blockNo wins (longer chain)
  it("prefers longer chain (higher blockNo)", () => {
    expect(preferCandidate(makeTip(100n, 50n), makeTip(101n, 51n), 1, k)).toBe(true);
  });

  it("rejects shorter chain (lower blockNo)", () => {
    expect(preferCandidate(makeTip(100n, 50n), makeTip(99n, 49n), 1, k)).toBe(false);
  });

  // Rule 2: at equal blockNo, lower VRF output wins (anti-grinding tiebreak).
  // Slot is deliberately NOT a tiebreaker — vanilla Praos does not use slot
  // density to break ties (cf. Haskell `comparePraos`,
  // `Praos/Common.hs:126-169`). Slot density is a Genesis-mode rule, not
  // Praos.
  it("prefers lower VRF output at equal blockNo", () => {
    const vrfLow = new Uint8Array(32).fill(0x01);
    const vrfHigh = new Uint8Array(32).fill(0xff);
    expect(preferCandidate(makeTip(100n, 50n, vrfHigh), makeTip(100n, 50n, vrfLow), 1, k)).toBe(
      true,
    );
  });

  it("rejects higher VRF output at equal blockNo", () => {
    const vrfLow = new Uint8Array(32).fill(0x01);
    const vrfHigh = new Uint8Array(32).fill(0xff);
    expect(preferCandidate(makeTip(100n, 50n, vrfLow), makeTip(100n, 50n, vrfHigh), 1, k)).toBe(
      false,
    );
  });

  // VRF tiebreak ignores the candidates' slots — even very different slots
  // resolve via VRF alone (cf. `comparePraos` at equal blockNo).
  it("VRF wins regardless of slot delta at equal blockNo", () => {
    const vrfLow = new Uint8Array(32).fill(0x00);
    const vrfHigh = new Uint8Array(32).fill(0xff);
    // candidate slot=200 (later) but VRF lower → candidate wins
    expect(preferCandidate(makeTip(100n, 50n, vrfHigh), makeTip(200n, 50n, vrfLow), 1, k)).toBe(
      true,
    );
    // candidate slot=100 (earlier) but VRF higher → ours wins
    expect(preferCandidate(makeTip(200n, 50n, vrfLow), makeTip(100n, 50n, vrfHigh), 1, k)).toBe(
      false,
    );
  });

  it("sticks with current when VRF outputs are equal", () => {
    const vrf = new Uint8Array(32).fill(0x42);
    expect(preferCandidate(makeTip(100n, 50n, vrf), makeTip(100n, 50n, vrf), 1, k)).toBe(false);
  });

  // VRF comparison is byte-level lexicographic (first differing byte decides).
  it("VRF comparison is lexicographic (first differing byte decides)", () => {
    const vrfA = new Uint8Array(32).fill(0x00);
    vrfA[0] = 0x01;
    const vrfB = new Uint8Array(32).fill(0x00);
    vrfB[0] = 0x02;
    expect(preferCandidate(makeTip(100n, 50n, vrfB), makeTip(100n, 50n, vrfA), 1, k)).toBe(true);
    expect(preferCandidate(makeTip(100n, 50n, vrfA), makeTip(100n, 50n, vrfB), 1, k)).toBe(false);
  });

  // Block number dominates VRF: even a worse VRF on a longer chain still wins.
  it("block number dominates VRF (higher blockNo wins even with worse VRF)", () => {
    const vrfHigh = new Uint8Array(32).fill(0xff);
    const vrfLow = new Uint8Array(32).fill(0x00);
    expect(preferCandidate(makeTip(100n, 40n, vrfLow), makeTip(100n, 50n, vrfHigh), 1, k)).toBe(
      true,
    );
  });

  // Rule 0: fork limit
  it("rejects fork deeper than k", () => {
    expect(preferCandidate(makeTip(100n, 50n), makeTip(3000n, 100n), k + 1, k)).toBe(false);
  });

  it("accepts fork at exactly k", () => {
    expect(preferCandidate(makeTip(100n, 50n), makeTip(200n, 51n), k, k)).toBe(true);
  });

  // Edge: no VRF output available — no preference; stick with current.
  // Mirrors Haskell's `vrfArmed = False ⇒ ShouldNotSwitch EQ`.
  it("sticks with current when neither side has VRF at equal blockNo", () => {
    expect(preferCandidate(makeTip(100n, 50n), makeTip(100n, 50n), 1, k)).toBe(false);
  });

  it("sticks with current when only one side has VRF", () => {
    const vrf = new Uint8Array(32).fill(0x42);
    expect(preferCandidate(makeTip(100n, 50n), makeTip(100n, 50n, vrf), 1, k)).toBe(false);
    expect(preferCandidate(makeTip(100n, 50n, vrf), makeTip(100n, 50n), 1, k)).toBe(false);
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
