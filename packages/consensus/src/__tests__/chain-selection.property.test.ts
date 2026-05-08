/**
 * Property tests for Praos chain selection (`preferCandidate`).
 *
 * Algebraic properties any chain-selection order must satisfy:
 *   - **Irreflexivity**: no chain is strictly preferred over itself.
 *   - **Asymmetry**: at most one of `prefer(A, B)` / `prefer(B, A)` is true.
 *   - **Fork-depth cap**: when `forkDepth > securityParam`, candidate is
 *     rejected regardless of block-number / slot / VRF.
 *   - **Length dominance**: higher `blockNo` wins at shallow fork depth.
 *   - **VRF tiebreak**: at equal `blockNo`, lexicographically-smaller VRF
 *     output wins (the *only* tiebreak in vanilla Praos).
 *
 * Vanilla Praos is length-first + VRF-tiebreak per Haskell `comparePraos`
 * (`ouroboros-consensus-protocol/.../Praos/Common.hs:126-169`). Slot
 * density is a Genesis-mode heuristic and explicitly NOT part of
 * `preferCandidate`; the `gsmState` helper in `chain-selection.ts`
 * tracks the GSM split for that.
 */
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { ChainTip, preferCandidate } from "../chain/selection.ts";
import { compareBytes } from "codecs";

const compareBytesLT = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) < 0;

const NUM_RUNS = 1_000;

const tipArb = Schema.toArbitrary(ChainTip);

describe("chain-selection (Praos)", () => {
  it("irreflexivity: preferCandidate(A, A, 0, k) === false", () => {
    FastCheck.assert(
      FastCheck.property(tipArb, (tip) => preferCandidate(tip, tip, 0, 2160) === false),
      { numRuns: NUM_RUNS },
    );
  });

  it("asymmetry: at most one of prefer(A, B) / prefer(B, A) is true", () => {
    FastCheck.assert(
      FastCheck.property(tipArb, tipArb, (a, b) => {
        const ab = preferCandidate(a, b, 1, 2160);
        const ba = preferCandidate(b, a, 1, 2160);
        return !(ab && ba);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("fork-depth cap: prefer is false when forkDepth > securityParam", () => {
    FastCheck.assert(
      FastCheck.property(
        tipArb,
        tipArb,
        FastCheck.integer({ min: 1, max: 1000 }),
        FastCheck.integer({ min: 1, max: 500 }),
        (ours, candidate, k, excess) => preferCandidate(ours, candidate, k + excess, k) === false,
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("length dominance: strictly-higher blockNo wins at shallow fork depth", () => {
    FastCheck.assert(
      FastCheck.property(tipArb, FastCheck.bigInt({ min: 1n, max: 1_000_000n }), (ours, delta) => {
        const better = new ChainTip({
          slot: ours.slot + delta,
          blockNo: ours.blockNo + delta,
          hash: ours.hash,
          ...(ours.vrfOutput !== undefined ? { vrfOutput: ours.vrfOutput } : {}),
        });
        return preferCandidate(ours, better, 1, 2160) === true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("VRF tiebreak: at equal blockNo, lexicographically-smaller VRF wins", () => {
    // Per `chain/selection.ts` and Haskell `comparePraos`
    // (`Praos/Common.hs:126-169`), vanilla Praos uses VRF-lowest as the
    // *only* tiebreak at equal blockNo — slot-density is a Genesis-mode
    // heuristic and explicitly NOT part of vanilla Praos chain selection.
    // Generate two distinct VRF outputs, sort lexicographically, assert
    // the smaller one beats the larger.
    const vrfArb = FastCheck.uint8Array({ minLength: 32, maxLength: 32 });
    FastCheck.assert(
      FastCheck.property(tipArb, vrfArb, vrfArb, (base, vrfA, vrfB) => {
        // Drop self-pairs — fast-check can produce identical bytes.
        if (vrfA.every((b, i) => b === vrfB[i])) return true;
        const lower = compareBytesLT(vrfA, vrfB) ? vrfA : vrfB;
        const higher = lower === vrfA ? vrfB : vrfA;
        const tipLower = new ChainTip({
          slot: base.slot,
          blockNo: base.blockNo,
          hash: base.hash,
          vrfOutput: lower,
        });
        const tipHigher = new ChainTip({
          slot: base.slot,
          blockNo: base.blockNo,
          hash: base.hash,
          vrfOutput: higher,
        });
        // ours = tipHigher (loser), candidate = tipLower (winner) → true
        return preferCandidate(tipHigher, tipLower, 1, 2160) === true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("shorter chains are never preferred", () => {
    FastCheck.assert(
      FastCheck.property(tipArb, FastCheck.bigInt({ min: 1n, max: 1_000_000n }), (ours, delta) => {
        const worse = new ChainTip({
          slot: ours.slot + delta,
          blockNo: ours.blockNo - delta,
          hash: ours.hash,
          ...(ours.vrfOutput !== undefined ? { vrfOutput: ours.vrfOutput } : {}),
        });
        if (worse.blockNo >= ours.blockNo) return true;
        return preferCandidate(ours, worse, 1, 2160) === false;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("boundary — preferCandidate(sample, sample, 0, k) is false (self)", () => {
    const sample = new ChainTip({
      slot: 100n,
      blockNo: 50n,
      hash: new Uint8Array(32).fill(1),
      vrfOutput: new Uint8Array(32).fill(2),
    });
    expect(preferCandidate(sample, sample, 0, 2160)).toBe(false);
  });
});
