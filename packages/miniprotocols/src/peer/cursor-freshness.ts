/**
 * Cursor-freshness check — run before a reactivated Peer entity resumes
 * ChainSync against a remote.
 *
 * Problem (plan §Phase 2e, wave-2 research): a passivated Peer entity
 * persists its ChainSync cursor via the `AdvanceCursor` Rpc's
 * `ClusterSchema.Persisted + WithTransaction` annotations. On
 * reactivation the persisted cursor may point at a slot the peer has
 * since rolled away from (the remote forked deeper than `k`). If we
 * blindly resume from that cursor we silently desync.
 *
 * Remedy (Haskell parity, `ChainSync.Client` — intersection-on-reconnect):
 * build a `MsgFindIntersect.points` list whose first candidate is our
 * persisted cursor and whose tail is Fibonacci-spaced fallback points
 * back to genesis. If the server returns `MsgIntersectNotFound` we count
 * the stale-reconnect metric + return a fresh cursor. Otherwise we use
 * whatever intersection the server accepted.
 *
 * Discriminated unions (`FreshnessResult`, `IntersectionReply`) are
 * schema-native tagged unions — dispatch via `.match` / `.isAnyOf` /
 * `.guards`, never raw `_tag === "…"` (see `packages/consensus/CLAUDE.md`
 * FP discipline).
 */
import { Effect, Metric, Option, Schema } from "effect";

import { ChainPointSchema, ChainPointType, type ChainPoint } from "../protocols/types/ChainPoint";
import { selectPoints } from "../protocols/chain-sync/points";
import { peerCursorStaleOnReconnect } from "../Metrics";

// ---------------------------------------------------------------------------
// Schema-typed tagged unions
// ---------------------------------------------------------------------------

/**
 * Outcome of a freshness probe. `Resumed` keeps the persisted cursor;
 * `Reset` means the remote could not intersect any candidate so we must
 * replay from genesis (or another fallback the caller picks from
 * `fallbackPoints`).
 */
export const FreshnessResult = Schema.Union([
  Schema.TaggedStruct("Resumed", { cursor: ChainPointSchema }),
  Schema.TaggedStruct("Reset", {
    cursor: ChainPointSchema,
    fallbackPoints: Schema.Array(ChainPointSchema),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type FreshnessResult = typeof FreshnessResult.Type;

/**
 * Narrow view of a ChainSync `MsgFindIntersect` reply — we only need the
 * two outcomes the freshness probe branches on. The full ChainSync
 * message type lives in `protocols/chain-sync/Schemas.ts`; callers
 * adapt down to this before invoking `onIntersectionReply`.
 */
export const IntersectionReply = Schema.Union([
  Schema.TaggedStruct("IntersectFound", { point: ChainPointSchema }),
  Schema.TaggedStruct("IntersectNotFound", {}),
]).pipe(Schema.toTaggedUnion("_tag"));
export type IntersectionReply = typeof IntersectionReply.Type;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originPoint: ChainPoint = ChainPointSchema.cases[ChainPointType.Origin].make({});

/**
 * Construct the `MsgFindIntersect.points` payload for a reactivating peer.
 * The persisted cursor goes first (most-recent), then Fibonacci-spaced
 * fallback anchors, then genesis. Callers send this to the remote and
 * dispatch on `MsgIntersectFound` / `MsgIntersectNotFound`.
 *
 * `cursorBlockNo` — the block number stamped on the persisted cursor.
 * `tipHint`       — our best local guess of the remote's tip block number,
 *                   used to clip offsets that would overshoot; pass 0 if
 *                   unknown (falls back to `k = 2160`).
 * `k`             — security parameter.
 *
 * Returns points ordered most-recent-first — the order
 * `MsgFindIntersect` expects (`ouroboros-network/api/lib/
 * Ouroboros/Network/AnchoredFragment.hs:392-398`).
 */
export const buildIntersectionPoints = (
  persistedCursor: ChainPoint,
  cursorBlockNo: bigint,
  tipHint: bigint,
  k = 2160,
): ReadonlyArray<ChainPoint> => {
  // Translate the Fibonacci offsets (block-number space) into ChainPoints.
  // We only have the slot+hash of the persisted cursor; the fallback
  // anchors reduce to `Origin` once the offset goes past the cursor's
  // block number, so the final list is: [persistedCursor, Origin].
  //
  // A fuller implementation would look up (slot, hash) pairs for each
  // Fibonacci offset against the local ChainDB. Phase 3c wires that
  // through `ChainDb.pointAtBlockNo(n)`; until then the fallback is
  // the conservative "persisted cursor + genesis" pair.
  const tip = tipHint > 0n ? tipHint : cursorBlockNo;
  const includeGenesis = selectPoints(tip, k).includes(0n);
  return [persistedCursor, ...(includeGenesis ? [originPoint] : [])];
};

/**
 * Dispatch on the remote's reply to a freshness-probe `MsgFindIntersect`.
 * Increments `peerCursorStaleOnReconnect` on `MsgIntersectNotFound`.
 *
 * The caller wires this into the peer entity's reactivation path:
 *
 *   ```ts
 *   const outcome = yield* onIntersectionReply(reply, persistedCursor);
 *   FreshnessResult.match(outcome, {
 *     Resumed: ({ cursor }) => // keep existing cursor
 *     Reset:   ({ cursor }) => // start sync from Origin
 *   });
 *   ```
 *
 * `persistedCursor` is currently unused by the body but kept in the
 * signature because call sites carry it and the Haskell reference
 * implementation uses it to pick a smarter fallback than `Origin`. Once
 * ChainDb.pointAtBlockNo lands (Phase 3c) we'll consult it here.
 */
export const onIntersectionReply = (
  intersection: IntersectionReply,
  _persistedCursor: ChainPoint,
): Effect.Effect<FreshnessResult> =>
  IntersectionReply.match(intersection, {
    IntersectFound: ({ point }) =>
      Effect.succeed<FreshnessResult>({ _tag: "Resumed", cursor: point }),
    // Stale cursor → reset to genesis + record the protocol-violation
    // metric so operator dashboards surface peers that consistently
    // fork past our persisted checkpoint.
    IntersectNotFound: () =>
      Metric.update(peerCursorStaleOnReconnect, 1).pipe(
        Effect.as<FreshnessResult>({
          _tag: "Reset",
          cursor: originPoint,
          fallbackPoints: [originPoint],
        }),
      ),
  });

/**
 * Unwrap a `FreshnessResult` to the cursor that should drive the next
 * ChainSync loop. Both variants carry a `cursor` — direct field access
 * avoids a spurious dispatch (TypeScript narrows the shared field).
 */
export const effectiveCursor = (result: FreshnessResult): ChainPoint => result.cursor;

/**
 * Check if a `FreshnessResult` represents a reset. Uses the schema's
 * generated per-case guard rather than a raw `_tag === "Reset"` compare.
 */
export const wasReset = (result: FreshnessResult): boolean => FreshnessResult.guards.Reset(result);

/**
 * Convenience: `Option<ChainPoint>` getter over the intersection reply
 * — `None` iff the remote couldn't find any overlap at our candidates.
 */
export const intersectionToOption = (intersection: IntersectionReply): Option.Option<ChainPoint> =>
  IntersectionReply.match(intersection, {
    IntersectFound: ({ point }) => Option.some(point),
    IntersectNotFound: () => Option.none(),
  });
