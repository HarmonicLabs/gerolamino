import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { CryptoDirect } from "wasm-utils/service.ts";
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

  // Test-coverage gap #5 — regression guard against re-introducing the
  // `8k/f` formulation that was fixed in wave-4 (the spec-correct value
  // is `4k/f` per Haskell `computeRandomnessStabilisationWindow`).
  //
  // The two formulae diverge by a factor of 2:
  //   4k/f (correct): for k=2160, f=0.05 ⇒ window = 172800, freeze at slot 259200
  //   8k/f (bug)    : same params       ⇒ window = 345600, freeze at slot  86400
  //
  // A slot strictly between the two freeze points (e.g. 100000) is the
  // discriminator — it returns FALSE with the correct 4k/f formula and
  // TRUE with the buggy 8k/f formula.
  describe("4k/f regression guard (wave-4 fix)", () => {
    it("slot 100000 (between 8k/f freeze and 4k/f freeze) — must be false", () => {
      // If this flips to true, someone re-introduced 8k/f. The
      // `100_000` value is the canonical bug-discriminator under
      // mainnet (k=2160, f=0.05) — well inside the 4k/f safe zone
      // (0..259199) but well past the 8k/f freeze (86400+).
      expect(isPastStabilizationWindow(100_000n, k, f, epochLength)).toBe(false);
    });

    it("computed window size matches Haskell ceiling(4k/f) = 172800 exactly", () => {
      // The boundary slot is `epochLength - ceiling(4k/f)`. Pin both
      // sides of the boundary to detect any algebraic drift — if the
      // formula becomes `2k/f`, `3k/f`, `8k/f`, etc., one of these
      // assertions flips.
      const expectedWindow = 172_800n; // ceiling(4 * 2160 / 0.05)
      const expectedFreezeSlot = epochLength - expectedWindow; // 259200n
      expect(isPastStabilizationWindow(expectedFreezeSlot - 1n, k, f, epochLength)).toBe(false);
      expect(isPastStabilizationWindow(expectedFreezeSlot, k, f, epochLength)).toBe(true);
    });

    it("preprod (same k/f as mainnet) — same 172800-slot window", () => {
      // Preprod inherits k=2160, f=0.05 from mainnet. epochLength
      // also matches at 432000. Same expected freeze.
      expect(isPastStabilizationWindow(259_199n, 2160, 0.05, 432_000n)).toBe(false);
      expect(isPastStabilizationWindow(259_200n, 2160, 0.05, 432_000n)).toBe(true);
    });

    it("alternative params (k=500, f=0.1) — formula generalises to 4·500/0.1 = 20000", () => {
      // Synthetic params chosen so 4k/f = 20000 differs cleanly from
      // 8k/f = 40000. epochLength = 100000 leaves room for both.
      const kAlt = 500;
      const fAlt = 0.1;
      const epochAlt = 100_000n;
      // 4k/f freeze at 80000; 8k/f freeze at 60000.
      // Slot 70000 is the discriminator (false for 4k/f, true for 8k/f).
      expect(isPastStabilizationWindow(70_000n, kAlt, fAlt, epochAlt)).toBe(false);
      expect(isPastStabilizationWindow(80_000n, kAlt, fAlt, epochAlt)).toBe(true);
    });
  });
});
