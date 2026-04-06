import { describe, it, expect } from "vitest";
import { evolveNonce, deriveEpochNonce, isPastStabilizationWindow } from "../nonce";

describe("evolveNonce", () => {
  it("produces a 32-byte hash", async () => {
    const nonce = new Uint8Array(32);
    nonce[0] = 0x42;
    const vrfOutput = new Uint8Array(32);
    vrfOutput[0] = 0x01;
    const result = await evolveNonce(nonce, vrfOutput);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  it("different inputs produce different outputs", async () => {
    const nonce = new Uint8Array(32);
    const vrf1 = new Uint8Array(32);
    vrf1[0] = 1;
    const vrf2 = new Uint8Array(32);
    vrf2[0] = 2;
    const r1 = await evolveNonce(nonce, vrf1);
    const r2 = await evolveNonce(nonce, vrf2);
    expect(r1).not.toEqual(r2);
  });

  it("is deterministic", async () => {
    const nonce = new Uint8Array(32).fill(0xaa);
    const vrfOutput = new Uint8Array(32).fill(0xbb);
    const r1 = await evolveNonce(nonce, vrfOutput);
    const r2 = await evolveNonce(nonce, vrfOutput);
    expect(r1).toEqual(r2);
  });
});

describe("deriveEpochNonce", () => {
  it("produces a 32-byte hash", async () => {
    const candidate = new Uint8Array(32).fill(0x11);
    const parentHash = new Uint8Array(32).fill(0x22);
    const result = await deriveEpochNonce(candidate, parentHash);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  it("is deterministic", async () => {
    const candidate = new Uint8Array(32).fill(0xcc);
    const parentHash = new Uint8Array(32).fill(0xdd);
    const r1 = await deriveEpochNonce(candidate, parentHash);
    const r2 = await deriveEpochNonce(candidate, parentHash);
    expect(r1).toEqual(r2);
  });
});

describe("isPastStabilizationWindow", () => {
  // Praos spec: candidate collection = 16k/f, quiet period = 8k/f, epoch = 24k/f
  // Mainnet: k=2160, f=0.05 → candidate end = ceil(16*2160/0.05) = 691200
  const k = 2160;
  const f = 0.05;
  const candidateEnd = 691200n; // 16k/f

  it("returns false for slot 0", () => {
    expect(isPastStabilizationWindow(0n, k, f)).toBe(false);
  });

  it("returns false just before the window", () => {
    expect(isPastStabilizationWindow(candidateEnd - 1n, k, f)).toBe(false);
  });

  it("returns true at the window boundary", () => {
    expect(isPastStabilizationWindow(candidateEnd, k, f)).toBe(true);
  });

  it("returns true well past the window", () => {
    expect(isPastStabilizationWindow(800000n, k, f)).toBe(true);
  });
});
