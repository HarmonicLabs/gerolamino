import { describe, it, expect } from "vitest";
import { evolveNonce, deriveEpochNonce, isPastStabilizationWindow } from "../nonce";
import { hex, concat } from "../util";

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

  // Ported from Amaru praos/nonce.rs — formula: blake2b(current ∥ blake2b(vrfOutput))
  it("follows Praos evolve formula: blake2b(current ∥ blake2b(vrfOutput))", async () => {
    const hasher = new Bun.CryptoHasher("blake2b256");
    const innerHash = (data: Uint8Array) =>
      new Uint8Array(new Bun.CryptoHasher("blake2b256").update(data).digest().buffer);

    const current = new Uint8Array(32).fill(0x42);
    const vrfOutput = new Uint8Array(32).fill(0x07);

    const result = await evolveNonce(current, vrfOutput);
    // Manual computation: blake2b(current ∥ blake2b(vrfOutput))
    const eta = innerHash(vrfOutput);
    const expected = innerHash(concat(current, eta));
    expect(hex(result)).toBe(hex(expected));
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

  // Ported from Dingo epoch_nonce_test.go — TestEpochNonceFormula
  it("follows Praos formula: blake2b(candidate ∥ parentHash)", async () => {
    const innerHash = (data: Uint8Array) =>
      new Uint8Array(new Bun.CryptoHasher("blake2b256").update(data).digest().buffer);

    const candidate = new Uint8Array(32).fill(0xaa);
    const parentHash = new Uint8Array(32).fill(0xbb);

    const result = await deriveEpochNonce(candidate, parentHash);
    const expected = innerHash(concat(candidate, parentHash));
    expect(hex(result)).toBe(hex(expected));
  });

  // Ported from Dingo epoch_nonce_test.go — TestEpochNonceNonCommutative
  it("is non-commutative (order of concatenation matters)", async () => {
    const a = new Uint8Array(32).fill(0x11);
    const b = new Uint8Array(32).fill(0x22);

    const ab = await deriveEpochNonce(a, b);
    const ba = await deriveEpochNonce(b, a);
    expect(hex(ab)).not.toBe(hex(ba));
  });

  // Ported from Dingo epoch_nonce_test.go — TestEpochNonceNeutralIdentity
  it("identity: deriving with zero-hash parent is different from just the candidate", async () => {
    const candidate = new Uint8Array(32).fill(0xcc);
    const zeroHash = new Uint8Array(32);
    const result = await deriveEpochNonce(candidate, zeroHash);
    // blake2b(cc...cc ∥ 00...00) ≠ cc...cc
    expect(hex(result)).not.toBe(hex(candidate));
  });
});

describe("isPastStabilizationWindow", () => {
  // Per Amaru/Haskell: randomness_stabilization_window = 4k/f
  // Candidate freezes at epochLength - 4k/f slots into epoch.
  // Mainnet: k=2160, f=0.05, epochLength=432000
  //   4k/f = 4*2160/0.05 = 172800
  //   candidateEnd = 432000 - 172800 = 259200
  const k = 2160;
  const f = 0.05;
  const epochLength = 432000n;
  const candidateEnd = 259200n; // epochLength - 4k/f

  it("returns false for slot 0", () => {
    expect(isPastStabilizationWindow(0n, k, f, epochLength)).toBe(false);
  });

  it("returns false just before the window", () => {
    expect(isPastStabilizationWindow(candidateEnd - 1n, k, f, epochLength)).toBe(false);
  });

  it("returns true at the window boundary", () => {
    expect(isPastStabilizationWindow(candidateEnd, k, f, epochLength)).toBe(true);
  });

  it("returns true well past the window", () => {
    expect(isPastStabilizationWindow(400000n, k, f, epochLength)).toBe(true);
  });
});
