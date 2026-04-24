/**
 * Fibonacci-spaced chain-point selector for `MsgFindIntersect`.
 *
 * Per Haskell `selectPoints` at
 * `~/code/reference/IntersectMBO/ouroboros-network/ouroboros-network-api/
 * lib/Ouroboros/Network/AnchoredFragment.hs:392-398`, the client sends
 * an ordered (most-recent-first) list of candidate intersection points
 * spaced at **Fibonacci offsets** from the tip:
 *
 *   selectPoints (0 : [ fib n | n <- [1 .. 17] ])
 *
 * This gives ~18 points that probe tip, tip-1, tip-1, tip-2, tip-3,
 * tip-5, tip-8, tip-13, ..., tip-1597 — densely near the tip (cheap to
 * resolve) but with logarithmic-depth reach so a forked peer is found
 * in O(log N) ChainSync probes. Clients that send shallower or
 * unordered lists get `MsgIntersectNotFound` even when overlap exists.
 *
 * This helper is pure — the caller supplies a `resolveHash` callback that
 * answers "what's the block hash at (tip.blockNo - offset)?". Historical
 * hashes are looked up from `ChainDb` / `ImmutableDB` at call time.
 *
 * Wave-2 research correction #12: the plan's earlier "exponential
 * powers-of-2" framing (`[tip, tip-1, tip-2, tip-4, tip-8, ...]`) was
 * wrong. Haskell uses Fibonacci. Use this helper, not ad-hoc spacing.
 */

import { compact, takeWhile } from "es-toolkit";

// ── Fibonacci via closed-form Binet ──────────────────────────────────
//
// `fib(n) = round((φⁿ − ψⁿ) / √5)` is exact (IEEE-754 doubles) up to
// n ≈ 70; we only need n ∈ [1..17] so precision is never close to the
// threshold. Closed-form gives us a stateless, allocation-free
// definition that composes with `Array.from({length}, mapper)` — no
// IIFE, no `let` accumulator, no loop.

const SQRT_5 = Math.sqrt(5);
const PHI = (1 + SQRT_5) / 2;
const PSI = (1 - SQRT_5) / 2;

/** Closed-form Fibonacci; `fib(0) = 0`, `fib(1) = 1`, … */
const fib = (n: number): number => Math.round((PHI ** n - PSI ** n) / SQRT_5);

/**
 * Haskell `[fib n | n <- [1..17]]` — 17 terms `[1, 1, 2, 3, …, 1597]`.
 * Built functionally via `Array.from({length}, mapper)` so the shape of
 * "produce N values by index" reads at the call site.
 */
const FIB_1_TO_17: ReadonlyArray<number> = Array.from({ length: 17 }, (_, i) => fib(i + 1));

/**
 * Default offsets — `0 : fib n for n in 1..17`, most-recent-first.
 * Length: 18. Max offset: fib(17) = 1597.
 *
 * Includes `0` (the tip itself) as the first candidate — Haskell also
 * includes 0 per `selectPoints` line 397.
 */
export const FIBONACCI_OFFSETS: ReadonlyArray<number> = [0, ...FIB_1_TO_17];

// ── Point resolution ─────────────────────────────────────────────────

/** A block identity at the granularity `MsgFindIntersect` expects. */
type Point = {
  readonly blockNo: bigint;
  readonly hash: Uint8Array;
  readonly slot: bigint;
};

/**
 * Construct an ordered list of intersection candidates.
 *
 * Semantics match Haskell:
 *  1. Walk offsets in declaration order (`FIBONACCI_OFFSETS`, ascending).
 *  2. Stop at the first offset exceeding `securityParam` **or** dropping
 *     below genesis (`tip.blockNo - offset < 0`).
 *  3. Within the surviving window, resolve each offset to a `Point` —
 *     `0` maps to the tip itself; the rest delegate to `resolveHash`.
 *  4. Drop any offset the caller couldn't resolve (pruned / below
 *     lower bound).
 *
 * @param tip Current best tip (blockNo + hash + slot) — must be known
 *   to the caller.
 * @param resolveHash Callback returning the `Point` at a given block
 *   number, or `null` if the block is unavailable (below genesis,
 *   pruned, etc.). Typically backed by `ChainDb.getBlockAtBlockNo`.
 * @param securityParam k — never probe deeper than `k` blocks from tip.
 * @returns Ordered list `[tip, tip-fib(1), …, tip-fib(17)]`,
 *   most-recent-first, with missing entries elided.
 */
export const fibonacciPoints = (
  tip: Point,
  resolveHash: (blockNo: bigint) => Point | null,
  securityParam: number,
): ReadonlyArray<Point> => {
  const inRange = (offset: number): boolean =>
    offset <= securityParam && tip.blockNo - BigInt(offset) >= 0n;
  const resolve = (offset: number): Point | null =>
    offset === 0 ? tip : resolveHash(tip.blockNo - BigInt(offset));

  // (1)+(2) stop-early via takeWhile; (3) resolve via .map; (4) drop
  // nulls via compact. No mutation, no `for`-loop, no `break`/`continue`.
  return compact(takeWhile(FIBONACCI_OFFSETS, inRange).map(resolve));
};
