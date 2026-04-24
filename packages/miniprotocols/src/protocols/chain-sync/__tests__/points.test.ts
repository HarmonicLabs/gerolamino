/**
 * Property tests for the Fibonacci-spaced `selectPoints` helper
 * (wave-2 correction #12 — Haskell upstream uses Fibonacci offsets,
 * NOT powers-of-2).
 *
 * Invariants asserted:
 *   1. Genesis (0) is always the final anchor.
 *   2. Points are monotonically decreasing (most-recent-first).
 *   3. Every interior point corresponds to a unique Fibonacci offset —
 *      no duplicate block numbers.
 *   4. At most `⌈log_φ(k) + 2⌉` interior points + genesis — stays tight
 *      even at k = 2160.
 */
import { describe, expect, it } from "@effect/vitest";
import * as FastCheck from "effect/testing/FastCheck";

import { selectPoints } from "../points";

describe("selectPoints (Fibonacci-spaced intersection candidates)", () => {
  it("tip=0 yields [0] (only genesis)", () => {
    expect(selectPoints(0n)).toEqual([0n]);
  });

  it("tip=1 yields [1, 0]", () => {
    expect(selectPoints(1n)).toEqual([1n, 0n]);
  });

  it("tip=13 (Fib-7) yields [13, 12, 11, 10, 8, 5, 0] — canonical shape", () => {
    expect(selectPoints(13n)).toEqual([13n, 12n, 11n, 10n, 8n, 5n, 0n]);
  });

  it("tip=2160 clamps at k=2160 with genesis anchor", () => {
    const pts = selectPoints(2160n, 2160);
    expect(pts[0]).toBe(2160n);
    expect(pts[pts.length - 1]).toBe(0n);
    // Point count should be tight — Fibonacci < k=2160 has 17 offsets
    // below 2160 (0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233,
    // 377, 610, 987, 1597) — dedup-at-collision trims one duplicate,
    // so expect ≤18 entries including genesis.
    expect(pts.length).toBeLessThanOrEqual(18);
  });

  it.prop(
    "every output is monotonically decreasing",
    [FastCheck.bigInt({ min: 0n, max: 10_000_000n })],
    ([tip]) => {
      const pts = selectPoints(tip);
      for (let i = 1; i < pts.length; i++) {
        expect(pts[i - 1]!).toBeGreaterThan(pts[i]!);
      }
    },
    { fastCheck: { numRuns: 100 } },
  );

  it.prop(
    "genesis (0) is always the final point",
    [FastCheck.bigInt({ min: 0n, max: 10_000_000n })],
    ([tip]) => {
      const pts = selectPoints(tip);
      expect(pts[pts.length - 1]).toBe(0n);
    },
    { fastCheck: { numRuns: 100 } },
  );

  it.prop(
    "all points are unique",
    [FastCheck.bigInt({ min: 0n, max: 10_000_000n })],
    ([tip]) => {
      const pts = selectPoints(tip);
      expect(new Set(pts).size).toBe(pts.length);
    },
    { fastCheck: { numRuns: 100 } },
  );

  it.prop(
    "all points are in [0, tip]",
    [FastCheck.bigInt({ min: 0n, max: 10_000_000n })],
    ([tip]) => {
      const pts = selectPoints(tip);
      for (const p of pts) {
        expect(p).toBeGreaterThanOrEqual(0n);
        expect(p).toBeLessThanOrEqual(tip);
      }
    },
    { fastCheck: { numRuns: 100 } },
  );
});
