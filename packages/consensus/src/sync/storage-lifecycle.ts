/**
 * ChainDB volatile → immutable promotion + GC.
 *
 * Shared by Mithril bootstrap (`sync/bootstrap.ts`) and live relay sync
 * (`sync/relay.ts`) so both paths trim OPFS/LSM volatile data once the
 * chain is deeper than `k` blocks.
 */
import { Effect, Option } from "effect";
import { ChainDB, ChainDBError, type RealPoint } from "storage";
import { SPAN } from "../observability.ts";

/** Promote volatile blocks to immutable when the volatile chain exceeds `k`.
 *  Returns the new volatile length (reset to `k` after promotion). */
export const maybePromoteVolatile = (
  k: number,
  volatileLength: number,
  immutableTip: Option.Option<RealPoint>,
): Effect.Effect<number, ChainDBError, ChainDB> =>
  Effect.gen(function* () {
    if (volatileLength <= k) return volatileLength;

    const chainDb = yield* ChainDB;

    if (Option.isSome(immutableTip)) {
      yield* chainDb.promoteToImmutable(immutableTip.value).pipe(
        Effect.withSpan(SPAN.PromoteVolatile, {
          attributes: { "chain.immutable_tip_slot": immutableTip.value.slot },
        }),
      );
      yield* chainDb.garbageCollect(immutableTip.value.slot);
    }

    return k;
  });
