import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { CryptoDirect } from "wasm-utils";
import { evolveNonce, deriveEpochNonce, isPastStabilizationWindow } from "../praos/nonce";
import { concat } from "../util";

const blake2b256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher("blake2b256").update(data).digest().buffer);

describe("evolveNonce", () => {
  it.effect("produces a 32-byte hash", () =>
    Effect.gen(function* () {
      const nonce = new Uint8Array(32);
      nonce[0] = 0x42;
      const vrfOutput = new Uint8Array(32);
      vrfOutput[0] = 0x01;
      const result = yield* evolveNonce(nonce, vrfOutput);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    }).pipe(Effect.provide(CryptoDirect)),
  );

  it.effect("different inputs produce different outputs", () =>
    Effect.gen(function* () {
      const nonce = new Uint8Array(32);
      const vrf1 = new Uint8Array(32);
      vrf1[0] = 1;
      const vrf2 = new Uint8Array(32);
      vrf2[0] = 2;
      const r1 = yield* evolveNonce(nonce, vrf1);
      const r2 = yield* evolveNonce(nonce, vrf2);
      expect(r1).not.toEqual(r2);
    }).pipe(Effect.provide(CryptoDirect)),
  );

  it.effect("is deterministic", () =>
    Effect.gen(function* () {
      const nonce = new Uint8Array(32).fill(0xaa);
      const vrfOutput = new Uint8Array(32).fill(0xbb);
      const r1 = yield* evolveNonce(nonce, vrfOutput);
      const r2 = yield* evolveNonce(nonce, vrfOutput);
      expect(r1).toEqual(r2);
    }).pipe(Effect.provide(CryptoDirect)),
  );

  // Ported from Amaru praos/nonce.rs — formula: blake2b(current ∥ blake2b(vrfOutput))
  it.effect("follows Praos evolve formula: blake2b(current ∥ blake2b(vrfOutput))", () =>
    Effect.gen(function* () {
      const current = new Uint8Array(32).fill(0x42);
      const vrfOutput = new Uint8Array(32).fill(0x07);

      const result = yield* evolveNonce(current, vrfOutput);
      // Manual computation: blake2b(current ∥ blake2b(vrfOutput))
      const eta = blake2b256(vrfOutput);
      const expected = blake2b256(concat(current, eta));
      expect(result.toHex()).toBe(expected.toHex());
    }).pipe(Effect.provide(CryptoDirect)),
  );
});

describe("deriveEpochNonce", () => {
  it.effect("produces a 32-byte hash", () =>
    Effect.gen(function* () {
      const candidate = new Uint8Array(32).fill(0x11);
      const parentHash = new Uint8Array(32).fill(0x22);
      const result = yield* deriveEpochNonce(candidate, parentHash);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    }).pipe(Effect.provide(CryptoDirect)),
  );

  it.effect("is deterministic", () =>
    Effect.gen(function* () {
      const candidate = new Uint8Array(32).fill(0xcc);
      const parentHash = new Uint8Array(32).fill(0xdd);
      const r1 = yield* deriveEpochNonce(candidate, parentHash);
      const r2 = yield* deriveEpochNonce(candidate, parentHash);
      expect(r1).toEqual(r2);
    }).pipe(Effect.provide(CryptoDirect)),
  );

  // Ported from Dingo epoch_nonce_test.go — TestEpochNonceFormula
  it.effect("follows Praos formula: blake2b(candidate ∥ parentHash)", () =>
    Effect.gen(function* () {
      const candidate = new Uint8Array(32).fill(0xaa);
      const parentHash = new Uint8Array(32).fill(0xbb);

      const result = yield* deriveEpochNonce(candidate, parentHash);
      const expected = blake2b256(concat(candidate, parentHash));
      expect(result.toHex()).toBe(expected.toHex());
    }).pipe(Effect.provide(CryptoDirect)),
  );

  // Ported from Dingo epoch_nonce_test.go — TestEpochNonceNonCommutative
  it.effect("is non-commutative (order of concatenation matters)", () =>
    Effect.gen(function* () {
      const a = new Uint8Array(32).fill(0x11);
      const b = new Uint8Array(32).fill(0x22);

      const ab = yield* deriveEpochNonce(a, b);
      const ba = yield* deriveEpochNonce(b, a);
      expect(ab.toHex()).not.toBe(ba.toHex());
    }).pipe(Effect.provide(CryptoDirect)),
  );

  // Ported from Dingo epoch_nonce_test.go — TestEpochNonceNeutralIdentity
  it.effect("identity: deriving with zero-hash parent is different from just the candidate", () =>
    Effect.gen(function* () {
      const candidate = new Uint8Array(32).fill(0xcc);
      const zeroHash = new Uint8Array(32);
      const result = yield* deriveEpochNonce(candidate, zeroHash);
      // blake2b(cc...cc ∥ 00...00) ≠ cc...cc
      expect(result.toHex()).not.toBe(candidate.toHex());
    }).pipe(Effect.provide(CryptoDirect)),
  );
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
