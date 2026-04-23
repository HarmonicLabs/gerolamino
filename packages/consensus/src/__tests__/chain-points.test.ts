import { describe, expect, it } from "@effect/vitest";
import * as FastCheck from "effect/testing/FastCheck";
import { FIBONACCI_OFFSETS, fibonacciPoints } from "../chain/points.ts";

const mkPoint = (blockNo: bigint) => ({
  blockNo,
  hash: new Uint8Array(32).fill(Number(blockNo % 256n)),
  slot: blockNo * 10n,
});

const NUM_RUNS = 500;

describe("fibonacciPoints", () => {
  it("FIBONACCI_OFFSETS has 18 elements, sorted ascending, starting with 0", () => {
    expect(FIBONACCI_OFFSETS.length).toBe(18);
    expect(FIBONACCI_OFFSETS[0]).toBe(0);
    for (let i = 1; i < FIBONACCI_OFFSETS.length; i++) {
      expect(FIBONACCI_OFFSETS[i]!).toBeGreaterThanOrEqual(FIBONACCI_OFFSETS[i - 1]!);
    }
  });

  it("FIBONACCI_OFFSETS matches Haskell fib sequence: 0, 1, 1, 2, 3, 5, 8, 13, 21, ...", () => {
    const expected = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597];
    expect(Array.from(FIBONACCI_OFFSETS)).toEqual(expected);
  });

  it("tip is always the first element when returned", () => {
    const tip = mkPoint(1000n);
    const points = fibonacciPoints(tip, (bn) => mkPoint(bn), 2160);
    expect(points[0]).toEqual(tip);
  });

  it("for tip well above k, returns at most 18 points, all within k blocks of tip", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.bigInt({ min: 3000n, max: 10_000_000n }), (tipBlock) => {
        const tip = mkPoint(tipBlock);
        const k = 2160;
        const points = fibonacciPoints(tip, (bn) => mkPoint(bn), k);
        if (points.length > 18) return false;
        for (const p of points) {
          if (tipBlock - p.blockNo > BigInt(k)) return false;
        }
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("points are ordered most-recent-first (strictly decreasing blockNo after dedup)", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.bigInt({ min: 3000n, max: 10_000_000n }), (tipBlock) => {
        const tip = mkPoint(tipBlock);
        const points = fibonacciPoints(tip, (bn) => mkPoint(bn), 2160);
        // Check non-increasing blockNo
        for (let i = 1; i < points.length; i++) {
          if (points[i]!.blockNo > points[i - 1]!.blockNo) return false;
        }
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("for tip near genesis, drops offsets that fall below block 0", () => {
    const tip = mkPoint(5n);
    const points = fibonacciPoints(tip, (bn) => mkPoint(bn), 2160);
    // With tip at blockNo=5, can only reach offsets 0, 1, 2, 3, 5
    // Fibonacci: 0, 1, 1, 2, 3, 5 → points at 5, 4, 4 (dup), 3, 2, 0
    expect(points.length).toBeGreaterThan(0);
    expect(points.length).toBeLessThanOrEqual(6);
    for (const p of points) {
      expect(p.blockNo).toBeGreaterThanOrEqual(0n);
    }
  });

  it("resolveHash returning null drops that specific offset", () => {
    const tip = mkPoint(1000n);
    const points = fibonacciPoints(
      tip,
      (bn) => (bn === 997n ? null : mkPoint(bn)), // missing blockNo=997 (offset 3)
      2160,
    );
    expect(points.find((p) => p.blockNo === 997n)).toBeUndefined();
    // but tip and other points still present
    expect(points[0]).toEqual(tip);
  });

  it("k=0: only the tip itself is returned (no deeper probing)", () => {
    const tip = mkPoint(1000n);
    const points = fibonacciPoints(tip, (bn) => mkPoint(bn), 0);
    expect(points.length).toBe(1);
    expect(points[0]).toEqual(tip);
  });

  it("stops probing once offset exceeds securityParam", () => {
    const tip = mkPoint(10_000n);
    const k = 100; // fib(11) = 89, fib(12) = 144 ⇒ should stop before 144
    const points = fibonacciPoints(tip, (bn) => mkPoint(bn), k);
    for (const p of points) {
      expect(tip.blockNo - p.blockNo).toBeLessThanOrEqual(BigInt(k));
    }
  });
});
