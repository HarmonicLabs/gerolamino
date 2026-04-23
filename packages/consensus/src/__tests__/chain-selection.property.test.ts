/**
 * Property tests for Praos chain selection (`preferCandidate`).
 *
 * Algebraic properties any chain-selection order must satisfy:
 *   - **Irreflexivity**: no chain is strictly preferred over itself.
 *   - **Asymmetry**: at most one of `prefer(A, B)` / `prefer(B, A)` is true.
 *   - **Fork-depth cap**: when `forkDepth > securityParam`, candidate is
 *     rejected regardless of block-number / slot / VRF.
 *   - **Length dominance**: higher `blockNo` wins at shallow fork depth.
 *   - **Density tiebreak**: at equal `blockNo`, lower `slot` (denser) wins.
 *
 * Vanilla Praos is length-first + VRF-tiebreak per Haskell `comparePraos`
 * (`ouroboros-consensus-protocol/.../Praos/Common.hs:126-169`). Density
 * belongs to GSM state, NOT to `preferCandidate` — see `gsmState` in
 * `chain-selection.ts` for the GSM split.
 */
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { ChainTip, preferCandidate } from "../chain/selection.ts";

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

  it("density tiebreak: at equal blockNo, lower slot wins", () => {
    FastCheck.assert(
      FastCheck.property(
        tipArb,
        FastCheck.bigInt({ min: 1n, max: 1_000_000n }),
        (ours, slotDelta) => {
          const denser = new ChainTip({
            slot: ours.slot - slotDelta,
            blockNo: ours.blockNo,
            hash: ours.hash,
            ...(ours.vrfOutput !== undefined ? { vrfOutput: ours.vrfOutput } : {}),
          });
          // Meaningful only when slot actually reduced (no BigInt underflow)
          if (denser.slot >= ours.slot) return true;
          return preferCandidate(ours, denser, 1, 2160) === true;
        },
      ),
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
