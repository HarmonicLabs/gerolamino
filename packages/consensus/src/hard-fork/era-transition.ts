/**
 * Hard Fork Combinator era-transition primitives.
 *
 * Models Cardano's era transitions (Byron→Shelley→Allegra→Mary→Alonzo→
 * Babbage→Conway) as a series of `EraBoundary` records + a binary-search
 * resolver for "what era is slot S in?".
 *
 * Semantics match the Haskell HFC (verified 2026-04-22 wave-2 against
 * `~/code/reference/IntersectMBO/ouroboros-consensus/.../HardFork/
 * Combinator/State.hs:222-336` and `Ledger.hs:163`): translation fires
 * during **tick**, not between block applications. `eraAtSlot` returns the
 * era that a block AT that slot validates under — the NEW era for the
 * boundary slot itself, not the outgoing era.
 *
 * State translation (`translate_{from}_{to}`) is NOT implemented here; it
 * requires the full ledger-state machinery (NewEpochState layouts per era)
 * which is phased after this scaffolding. Consumers wire translation via
 * a `translate` callback passed into `tickToSlot` (see `dispatch.ts`).
 */
import { Data, Schema } from "effect";
import { Era, EraSchema } from "ledger/lib/core/era.ts";

// ---------------------------------------------------------------------------
// EraBoundary — a single era transition point
// ---------------------------------------------------------------------------

/**
 * A hard-fork boundary: the chain transitioned from `fromEra` to `toEra` at
 * the start of `epoch`, which began at `slot`. Blocks at `slot <= s` are
 * validated under `toEra` rules (post-translation); blocks at `s < slot`
 * are validated under `fromEra` rules.
 */
export class EraBoundary extends Schema.Class<EraBoundary>("EraBoundary")({
  fromEra: EraSchema,
  toEra: EraSchema,
  epoch: Schema.BigInt,
  slot: Schema.BigInt,
}) {}

// ---------------------------------------------------------------------------
// EraHistory — ordered sequence of boundaries + current era
// ---------------------------------------------------------------------------

/**
 * Ordered sequence of era boundaries encountered so far. `boundaries` must
 * be sorted by `slot` ascending (and by `epoch` ascending, equivalent on
 * Cardano where epoch length is constant within an era). `currentEra`
 * names the era the chain has entered most recently; it's redundant with
 * the last boundary's `toEra` when boundaries is non-empty.
 *
 * For a freshly-initialized genesis-era chain, `boundaries` is empty and
 * `currentEra = Era.Byron` (or whatever genesis era applies).
 */
export class EraHistory extends Schema.Class<EraHistory>("EraHistory")({
  boundaries: Schema.Array(EraBoundary),
  currentEra: EraSchema,
}) {}

// ---------------------------------------------------------------------------
// eraAtSlot — resolve which era a given slot falls into
// ---------------------------------------------------------------------------

/**
 * Return the era a block at `slot` validates under. Post-translation
 * semantics: the boundary slot itself is in the NEW era (`toEra`), not the
 * outgoing era. Binary search — O(log n) in boundary count.
 *
 * Edge cases:
 *   - Empty history: returns `currentEra` unconditionally.
 *   - Slot before first boundary: returns the first boundary's `fromEra`
 *     (the chain was in that era before any transition).
 *   - Slot ≥ last boundary: returns the last boundary's `toEra`.
 */
export const eraAtSlot = (history: EraHistory, slot: bigint): Era => {
  const bs = history.boundaries;
  if (bs.length === 0) return history.currentEra;
  if (slot < bs[0]!.slot) return bs[0]!.fromEra;

  // Binary search for the largest i such that bs[i].slot <= slot.
  let lo = 0;
  let hi = bs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (bs[mid]!.slot <= slot) lo = mid;
    else hi = mid - 1;
  }
  return bs[lo]!.toEra;
};

// ---------------------------------------------------------------------------
// crossesEraBoundary — predicate for boundary-straddling slot ranges
// ---------------------------------------------------------------------------

/**
 * True iff advancing from `fromSlot` to `toSlot` crosses one or more era
 * boundaries. Used by the `tickToSlot` dispatcher to know when to invoke
 * `translate_*` state-migration callbacks.
 */
export const crossesEraBoundary = (
  history: EraHistory,
  fromSlot: bigint,
  toSlot: bigint,
): boolean => {
  if (toSlot <= fromSlot) return false;
  const bs = history.boundaries;
  for (const b of bs) {
    if (b.slot > fromSlot && b.slot <= toSlot) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// EraOrdering — lightweight error carrier for malformed histories
// ---------------------------------------------------------------------------

/**
 * Thrown by `validateEraHistory` when boundaries are not monotonically
 * increasing by `slot` / `epoch` — indicates an ill-formed history that
 * would break `eraAtSlot`'s binary-search invariant.
 */
export class EraHistoryOrderError extends Data.TaggedError("EraHistoryOrderError")<{
  readonly message: string;
  readonly boundaryIndex: number;
}> {}

/**
 * Check that `history.boundaries` is strictly monotonic on `slot` and
 * `epoch`, and that adjacent boundaries' eras chain (`boundaries[i].toEra
 * === boundaries[i+1].fromEra`). Returns `null` on success or an
 * `EraHistoryOrderError` identifying the first bad index.
 */
export const validateEraHistory = (history: EraHistory): EraHistoryOrderError | null => {
  const bs = history.boundaries;
  for (let i = 1; i < bs.length; i++) {
    const prev = bs[i - 1]!;
    const cur = bs[i]!;
    if (cur.slot <= prev.slot) {
      return new EraHistoryOrderError({
        message: `boundary ${i} slot ${cur.slot} not strictly greater than prev ${prev.slot}`,
        boundaryIndex: i,
      });
    }
    if (cur.epoch <= prev.epoch) {
      return new EraHistoryOrderError({
        message: `boundary ${i} epoch ${cur.epoch} not strictly greater than prev ${prev.epoch}`,
        boundaryIndex: i,
      });
    }
    if (prev.toEra !== cur.fromEra) {
      return new EraHistoryOrderError({
        message: `boundary ${i} fromEra (${Era[cur.fromEra]}) does not chain from prev toEra (${Era[prev.toEra]})`,
        boundaryIndex: i,
      });
    }
  }
  if (bs.length > 0 && history.currentEra !== bs[bs.length - 1]!.toEra) {
    return new EraHistoryOrderError({
      message: `currentEra (${Era[history.currentEra]}) does not match last boundary toEra (${Era[bs[bs.length - 1]!.toEra]})`,
      boundaryIndex: bs.length,
    });
  }
  return null;
};
