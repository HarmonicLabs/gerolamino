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
 * tip-5, tip-8, tip-13, ..., tip-1597, tip-2584 — densely near the tip
 * (cheap to resolve) but with logarithmic-depth reach so a forked peer
 * is found in O(log N) ChainSync probes. Clients that send shallower
 * or unordered lists get `MsgIntersectNotFound` even when overlap exists.
 *
 * This helper is pure — the caller supplies a `resolveHash` callback that
 * answers "what's the block hash at (tip.blockNo - offset)?". Historical
 * hashes are looked up from `ChainDb` / `ImmutableDB` at call time.
 *
 * Wave-2 research correction #12: the plan's earlier "exponential
 * powers-of-2" framing (`[tip, tip-1, tip-2, tip-4, tip-8, ...]`) was
 * wrong. Haskell uses Fibonacci. Use this helper, not ad-hoc spacing.
 */

/**
 * Fibonacci sequence starting at fib(1) = 1, fib(2) = 1.
 * Matches Haskell's `fib` at n ∈ [1..17] ⇒ 17 terms.
 */
const FIB_OFFSETS: ReadonlyArray<number> = (() => {
  const out: number[] = [];
  let a = 1;
  let b = 1;
  for (let n = 1; n <= 17; n++) {
    out.push(a);
    const next = a + b;
    a = b;
    b = next;
  }
  return out;
})();

/**
 * Default offsets — `0 : fib n for n in 1..17`, most-recent-first.
 * Length: 18. Max offset: fib(17) = 1597.
 *
 * Includes `0` (the tip itself) as the first candidate. Haskell also
 * includes 0 per `selectPoints` line 397.
 */
export const FIBONACCI_OFFSETS: ReadonlyArray<number> = [0, ...FIB_OFFSETS];

/**
 * Construct an ordered list of intersection candidates.
 *
 * @param tip Current best tip (blockNo + hash) — must be known to caller.
 * @param resolveHash Callback returning the hash at a given block number,
 *   or `null` if the block is unavailable (below genesis, pruned, etc.).
 *   Typically backed by `ChainDb.getBlockAtBlockNo` or similar.
 * @param securityParam k — never probe deeper than k blocks.
 * @returns Ordered list `[tip, tip-fib(1), ..., tip-fib(17), genesis?]`,
 *   most-recent-first. Blocks outside range (below block 0 or deeper than k)
 *   are dropped. If resolveHash returns null for an offset, that offset is
 *   dropped — the client ends up with a shorter list.
 *
 * Complexity: O(18) resolveHash calls.
 */
export const fibonacciPoints = <Point>(
  tip: { readonly blockNo: bigint; readonly hash: Uint8Array; readonly slot: bigint },
  resolveHash: (blockNo: bigint) => {
    readonly blockNo: bigint;
    readonly hash: Uint8Array;
    readonly slot: bigint;
  } | null,
  securityParam: number,
): ReadonlyArray<{ readonly blockNo: bigint; readonly hash: Uint8Array; readonly slot: bigint }> => {
  const kBig = BigInt(securityParam);
  const out: Array<{ readonly blockNo: bigint; readonly hash: Uint8Array; readonly slot: bigint }> =
    [];
  for (const offset of FIBONACCI_OFFSETS) {
    const target = tip.blockNo - BigInt(offset);
    if (target < 0n) break; // fell off the front — stop probing deeper
    if (BigInt(offset) > kBig) break; // past security parameter
    if (offset === 0) {
      // The tip itself, no lookup needed
      out.push({ blockNo: tip.blockNo, hash: tip.hash, slot: tip.slot });
      continue;
    }
    const resolved = resolveHash(target);
    if (resolved === null) continue; // skip missing points
    out.push(resolved);
  }
  return out;
};
