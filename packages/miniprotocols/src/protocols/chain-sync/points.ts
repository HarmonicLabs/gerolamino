/**
 * `selectPoints` — compute Fibonacci-spaced intersection candidates for
 * `MsgFindIntersect`, TS port of the upstream Haskell helper.
 *
 * The Ouroboros ChainSync protocol (`ouroboros-network/api/lib/
 * Ouroboros/Network/AnchoredFragment.hs:392-398`) expects
 * `MsgFindIntersect.points` to be ordered most-recent-first and spaced
 * with **Fibonacci offsets**, NOT powers of 2. Each offset `fib(n)` is
 * subtracted from the tip block number; offsets past the chain's length
 * drop off, and genesis anchors the list as a final fallback.
 *
 * Wave-2 research correction #12 — the earlier plan wording cited
 * "powers-of-2" which was wrong. Fibonacci gives denser spacing near the
 * tip (where recent forks are common) while still reaching deep anchors
 * with O(log N) points.
 *
 * The returned list has at most `⌈log_φ(k) + 2⌉` entries — well under 20
 * even at k = 2160 — plus genesis.
 */
import { takeWhile, uniq } from "es-toolkit";

/**
 * Closed-form Fibonacci offsets `[0, 1, 2, 3, 5, 8, 13, …]`.
 *
 * Truncated by ⌈log_φ(k) + 2⌉ upper bound — φ = (1+√5)/2 ≈ 1.618, so for
 * k = 2160 we produce at most ~17 offsets before the takeWhile clip
 * kicks in. Slicing well above the clip point is fine; it's bounded
 * small-finite.
 */
const LN_PHI = Math.log((1 + Math.sqrt(5)) / 2);
const fibOffsetCount = (k: number): number =>
  Math.min(64, Math.ceil(Math.log(Math.max(2, k)) / LN_PHI) + 3);

/**
 * Produce the Fibonacci offset series up to (but not past) `limit`
 * inclusive. Each offset is computed via the closed-form
 * `Array.from({length}, mapper)` pattern — no mutation, no generators.
 * Bulk-allocates a tiny fixed-size array (≤ 20 entries in practice) and
 * clips by `takeWhile` to the requested upper bound.
 */
const fibOffsetsUpTo = (limit: number): ReadonlyArray<number> => {
  const length = fibOffsetCount(limit);
  const series = Array.from({ length }, (_, i) => {
    // Binet's formula — closed-form `fib(n)` for n ≤ 64. We only need
    // small `n` (k = 2160 → n ≤ 17) so IEEE-754 precision is plenty.
    const phi = (1 + Math.sqrt(5)) / 2;
    const psi = (1 - Math.sqrt(5)) / 2;
    return Math.round((phi ** i - psi ** i) / Math.sqrt(5));
  });
  return takeWhile(series, (offset) => offset <= limit);
};

/**
 * Select intersection candidate points for a chain with the given tip
 * block number. Returns block numbers (not slot numbers — the caller is
 * responsible for looking up the corresponding slot + hash via the local
 * chain DB).
 *
 * @param tipBlockNo - block number of the chain tip (caller's local cursor)
 * @param k - security parameter (default 2160 — preprod/mainnet value)
 * @returns most-recent-first block numbers, with 0 (genesis) appended
 */
export const selectPoints = (tipBlockNo: bigint, k = 2160): ReadonlyArray<bigint> => {
  // Project offsets into candidate block numbers (tip - offset), drop
  // negatives, dedup consecutive duplicates, and always terminate at
  // genesis.
  const candidates = fibOffsetsUpTo(k)
    .map((offset) => tipBlockNo - BigInt(offset))
    .filter((candidate) => candidate >= 0n);
  return uniq([...candidates, 0n]);
};
