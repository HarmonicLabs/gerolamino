/**
 * Praos leader-check invariants — independent cross-check of `check_vrf_leader`.
 *
 * The Rust implementation composes `pallas_math::FixedDecimal::exp_cmp` to
 * compute the Praos threshold `1 - (1-f)^sigma` and compares against the
 * normalised VRF output. Because the math primitive is itself pallas-math,
 * a TS reimplementation of the formula would be circular.
 *
 * Instead, this suite fuzzes inputs through the WASM export and asserts
 * mathematical invariants that any correct implementation of the Praos
 * threshold formula must satisfy.
 *
 * VRF-output encoding: pallas-math parses the "vrf_output_hex" argument with
 * `FixedDecimal::from_str(s, DEFAULT_PRECISION=34)`, i.e. as a DECIMAL integer
 * whose scaled value is `n * 10^-34`. Values in [0, 10^34) therefore normalise
 * to [0, 1) for the threshold comparison `vrf < 1 - (1-f)^sigma`.
 *
 * Praos domain constraints enforced on all arbitraries:
 *   - sigma ∈ [0, 1]  (stake fraction — a probability)
 *   - f     ∈ (0, 1)  (active-slot coefficient — strictly < 1; f = 1 maps to
 *                       ln(0) in the threshold math and pallas-math panics)
 *   - vrf   ∈ [0, 1)  (normalised 64-byte VRF output)
 *
 *   1. Boundaries (leader iff vrf < threshold = 1 - (1-f)^sigma):
 *      - sigma = 0        → threshold = 0 → never leader
 *      - sigma ≈ 1, f ≈ 1 → threshold → 1 → always leader for vrf < 1
 *      - vrf ≈ 1, f < 1   → threshold < 1 → never leader
 *
 *   2. Monotonicity (threshold is non-decreasing in sigma and f):
 *      - isLeader(sigma_low, f, vrf) && sigma_low ≤ sigma_high
 *        ⇒ isLeader(sigma_high, f, vrf)
 *      - isLeader(sigma, f_low, vrf) && f_low ≤ f_high
 *        ⇒ isLeader(sigma, f_high, vrf)
 *
 *   3. Anti-monotonicity in vrf (threshold fixed, leader closed downward in vrf):
 *      - isLeader(sigma, f, vrf_high) && vrf_low ≤ vrf_high
 *        ⇒ isLeader(sigma, f, vrf_low)
 *
 *   4. Determinism (same input → same output across repeated calls).
 */
import { describe, expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import * as FastCheck from "effect/testing/FastCheck";

import { Crypto, CryptoDirect } from "../index.ts";

// `FixedDecimal` precision used by pallas-math; values [0, 10^34) map to [0, 1).
const FIXED_MAX = 10n ** 34n;

// Canonical endpoints in the normalised VRF space.
const VRF_NEAR_ZERO = "1"; // 1 * 10^-34, strictly > 0 (boundary "effectively zero")
const VRF_NEAR_ONE = (FIXED_MAX - 1n).toString(); // 10^34 - 1, strictly < 1

// Praos-domain arbitraries — tight enough to keep pallas-math out of its panic paths.
const vrfNormalisedArb = FastCheck.bigInt({ min: 0n, max: FIXED_MAX - 1n });

// f ∈ [0.01, 0.99] → numerator ∈ [1, 99] with denominator "100".
const fNumArb = FastCheck.bigInt({ min: 1n, max: 99n });
const F_DEN = "100";

// sigma ∈ [1e-6, 1] → numerator ∈ [1, 1_000_000] with denominator "1000000".
const sigmaNumArb = FastCheck.bigInt({ min: 1n, max: 1_000_000n });
const SIGMA_DEN = "1000000";

layer(CryptoDirect)("Praos leader-check invariants", (it) => {
  describe("boundary conditions", () => {
    it.effect("sigma = 0 is never a leader, even with VRF ≈ 0 and f near 1", () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto;
        const leader = yield* crypto.checkVrfLeader(VRF_NEAR_ZERO, "0", "1", "99", "100");
        expect(leader).toBe(false);
      }),
    );

    it.effect("sigma = 1 with f near 1 and VRF ≈ 0 is always a leader", () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto;
        // threshold = 1 - (1 - 0.99)^1 = 0.99 ≫ 10^-34
        const leader = yield* crypto.checkVrfLeader(VRF_NEAR_ZERO, "1", "1", "99", "100");
        expect(leader).toBe(true);
      }),
    );

    it.effect("VRF ≈ 1 is never a leader (threshold < 1 for f < 1)", () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto;
        const leader = yield* crypto.checkVrfLeader(VRF_NEAR_ONE, "1", "2", "5", "100");
        expect(leader).toBe(false);
      }),
    );
  });

  describe("determinism", () => {
    it.effect.prop(
      "same inputs yield identical outputs across repeated calls",
      [vrfNormalisedArb, sigmaNumArb, fNumArb],
      ([vrf, sigmaNum, fNum]) =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const vrfs = vrf.toString();
          const sn = sigmaNum.toString();
          const fn = fNum.toString();
          const a = yield* crypto.checkVrfLeader(vrfs, sn, SIGMA_DEN, fn, F_DEN);
          const b = yield* crypto.checkVrfLeader(vrfs, sn, SIGMA_DEN, fn, F_DEN);
          expect(a).toBe(b);
        }),
      { fastCheck: { numRuns: 30 } },
    );
  });

  describe("monotonicity in sigma (threshold ↑ in sigma ⇒ isLeader closed upward)", () => {
    it.effect.prop(
      "isLeader(sigma_low) implies isLeader(sigma_high) for sigma_low ≤ sigma_high",
      [
        vrfNormalisedArb,
        FastCheck.bigInt({ min: 1n, max: 500_000n }),
        FastCheck.bigInt({ min: 500_001n, max: 1_000_000n }),
        fNumArb,
      ],
      ([vrf, sigmaLow, sigmaHigh, fNum]) =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const vrfs = vrf.toString();
          const fn = fNum.toString();
          const low = yield* crypto.checkVrfLeader(vrfs, sigmaLow.toString(), SIGMA_DEN, fn, F_DEN);
          const high = yield* crypto.checkVrfLeader(vrfs, sigmaHigh.toString(), SIGMA_DEN, fn, F_DEN);
          if (low) expect(high).toBe(true);
        }),
      { fastCheck: { numRuns: 40 } },
    );
  });

  describe("monotonicity in f (threshold ↑ in f ⇒ isLeader closed upward)", () => {
    it.effect.prop(
      "isLeader(f_low) implies isLeader(f_high) for f_low ≤ f_high",
      [
        vrfNormalisedArb,
        FastCheck.bigInt({ min: 1n, max: 10n }),
        FastCheck.bigInt({ min: 11n, max: 99n }),
        sigmaNumArb,
      ],
      ([vrf, fLow, fHigh, sigmaNum]) =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const vrfs = vrf.toString();
          const sn = sigmaNum.toString();
          const low = yield* crypto.checkVrfLeader(vrfs, sn, SIGMA_DEN, fLow.toString(), F_DEN);
          const high = yield* crypto.checkVrfLeader(vrfs, sn, SIGMA_DEN, fHigh.toString(), F_DEN);
          if (low) expect(high).toBe(true);
        }),
      { fastCheck: { numRuns: 40 } },
    );
  });

  describe("anti-monotonicity in VRF (leader closed downward in vrf)", () => {
    it.effect.prop(
      "isLeader(vrf_high) implies isLeader(vrf_low) for vrf_low ≤ vrf_high",
      [
        FastCheck.bigInt({ min: 0n, max: FIXED_MAX / 2n - 1n }),
        FastCheck.bigInt({ min: FIXED_MAX / 2n, max: FIXED_MAX - 1n }),
        sigmaNumArb,
        fNumArb,
      ],
      ([vrfLow, vrfHigh, sigmaNum, fNum]) =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const sn = sigmaNum.toString();
          const fn = fNum.toString();
          const lowLeader = yield* crypto.checkVrfLeader(vrfLow.toString(), sn, SIGMA_DEN, fn, F_DEN);
          const highLeader = yield* crypto.checkVrfLeader(vrfHigh.toString(), sn, SIGMA_DEN, fn, F_DEN);
          if (highLeader) expect(lowLeader).toBe(true);
        }),
      { fastCheck: { numRuns: 40 } },
    );
  });

  describe("non-leader stability at VRF ≈ 1", () => {
    it.effect.prop(
      "with f < 1, VRF ≈ 1 is never a leader regardless of sigma",
      [sigmaNumArb, fNumArb],
      ([sigmaNum, fNum]) =>
        Effect.gen(function* () {
          const crypto = yield* Crypto;
          const leader = yield* crypto.checkVrfLeader(
            VRF_NEAR_ONE,
            sigmaNum.toString(),
            SIGMA_DEN,
            fNum.toString(),
            F_DEN,
          );
          expect(leader).toBe(false);
        }),
      { fastCheck: { numRuns: 30 } },
    );
  });
});
