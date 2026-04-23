/**
 * Property tests for Praos nonce evolution.
 *
 * `isPastStabilizationWindow` is a pure arithmetic predicate — ideal for
 * property testing. `evolveNonce` + `deriveEpochNonce` require `Crypto`
 * service injection; we cover their algebraic shape via the pure
 * stabilization-window predicate + explicit spec-value assertions.
 *
 * Spec references:
 * - Praos §3.4: nonce evolution mechanics
 * - Randomness stabilization window = 4k/f slots (Praos §4.3)
 * - Mainnet standard: k=2160, f=0.05 → window = 172_800 slots, freeze at
 *   slot (432_000 - 172_800) = 259_200 of the 432_000-slot epoch.
 */
import { describe, expect, it } from "@effect/vitest";
import * as FastCheck from "effect/testing/FastCheck";
import { isPastStabilizationWindow } from "../praos/nonce.ts";

const NUM_RUNS = 1_000;

describe("nonce stabilization window (Praos §4.3)", () => {
  it("false for slots strictly before the freeze point", () => {
    FastCheck.assert(
      FastCheck.property(
        // slot range: 0 to just-before-freeze
        FastCheck.bigInt({ min: 0n, max: 259_199n }),
        (slotInEpoch) =>
          isPastStabilizationWindow(slotInEpoch, 2160, 0.05, 432_000n) === false,
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("true for slots at or after the freeze point", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.bigInt({ min: 259_200n, max: 432_000n }),
        (slotInEpoch) =>
          isPastStabilizationWindow(slotInEpoch, 2160, 0.05, 432_000n) === true,
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("monotonic: once true, stays true for all larger slots in the same epoch", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.bigInt({ min: 0n, max: 432_000n }),
        FastCheck.bigInt({ min: 0n, max: 432_000n }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const loResult = isPastStabilizationWindow(lo, 2160, 0.05, 432_000n);
          const hiResult = isPastStabilizationWindow(hi, 2160, 0.05, 432_000n);
          // Monotonic: (lo is past) ⇒ (hi is past).
          return loResult ? hiResult : true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("window scales with k and 1/f", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: 1, max: 10_000 }),
        FastCheck.double({ min: 0.001, max: 1.0, noNaN: true }),
        FastCheck.bigInt({ min: 10_000n, max: 1_000_000n }),
        (k, f, epochLength) => {
          // Freeze point = epochLength - ceil(4k/f). Monotonic in both k (↑) and 1/f (↑).
          // Check: epochLength - 1 is past iff ceil(4k/f) >= 1 (always true for positive k, f).
          const windowSlots = BigInt(Math.ceil((4 * k) / f));
          const freezePoint = epochLength - windowSlots;
          if (freezePoint < 0n) return true; // window larger than epoch — degenerate
          const atFreezePoint = isPastStabilizationWindow(freezePoint, k, f, epochLength);
          const justBefore = freezePoint === 0n
            ? true // can't go before 0
            : isPastStabilizationWindow(freezePoint - 1n, k, f, epochLength) === false;
          return atFreezePoint && justBefore;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("boundary: mainnet spec values (k=2160, f=0.05, 432_000-slot epoch)", () => {
    // Before freeze
    expect(isPastStabilizationWindow(259_199n, 2160, 0.05, 432_000n)).toBe(false);
    expect(isPastStabilizationWindow(0n, 2160, 0.05, 432_000n)).toBe(false);
    // At and after freeze
    expect(isPastStabilizationWindow(259_200n, 2160, 0.05, 432_000n)).toBe(true);
    expect(isPastStabilizationWindow(432_000n, 2160, 0.05, 432_000n)).toBe(true);
  });
});
