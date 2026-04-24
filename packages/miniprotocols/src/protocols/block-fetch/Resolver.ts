/**
 * BlockFetch resolver — `RequestResolver`-based API layered atop the raw
 * `BlockFetchClient.requestRange`. Consumers use `Effect.request(...)`
 * with `FetchBlockRange`; the resolver:
 *
 *   - Deduplicates concurrent requests for the same range into a single
 *     wire `MsgRequestRange`.
 *   - Caps in-flight wire requests via `RequestResolver.batchN` so we
 *     never exceed the protocol's pipelining window (spec §3.15 allocates
 *     721KB ingress buffer → ~11 concurrent range requests).
 *   - Emits `blockFetchLatency` per completed range so per-peer fetch
 *     throughput shows up in telemetry.
 *
 * Downstream consensus (`packages/consensus/src/sync/bootstrap.ts` and
 * future Phase-3f `BlockSync` stages) depend only on this resolver
 * surface; they don't construct raw `MsgRequestRange` frames.
 */
import {
  Clock,
  Context,
  Effect,
  Layer,
  Metric,
  Option,
  Request,
  RequestResolver,
  Schema,
  Stream,
} from "effect";

import { blockFetchLatency } from "../../Metrics";
import type { ChainPoint } from "../types/ChainPoint";
import { BlockFetchClient, BlockFetchError } from "./Client";

/**
 * Request for a closed range of blocks. The resolver treats same-range
 * concurrent requests as duplicates and services them from a single wire
 * call.
 */
export class FetchBlockRange extends Request.TaggedClass("FetchBlockRange")<
  { readonly from: ChainPoint; readonly to: ChainPoint },
  ReadonlyArray<Uint8Array>,
  BlockFetchError
> {}
export type FetchBlockRangeResult = ReadonlyArray<Uint8Array>;

/**
 * Config — maximum concurrent range requests in flight. Spec §3.15's
 * 721KB ingress buffer supports ~11; we default to 11 but expose an
 * override for tests + SPO tooling that want a smaller blast radius.
 */
const DEFAULT_MAX_IN_FLIGHT = 11;

/** Resolver that delegates to `BlockFetchClient.requestRange`. */
export const makeResolver = (options?: { readonly maxInFlight?: number }) =>
  Effect.gen(function* () {
    const client = yield* BlockFetchClient;
    const maxInFlight = options?.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;

    /** Collapse every underlying failure (stream errors, schema errors,
     * timeouts) to the `BlockFetchError` the request class declares. */
    const toBlockFetchError = (cause: unknown): BlockFetchError =>
      cause instanceof BlockFetchError ? cause : new BlockFetchError({ cause });

    const base = RequestResolver.fromEffect(
      (
        entry: Request.Entry<FetchBlockRange>,
      ): Effect.Effect<FetchBlockRangeResult, BlockFetchError> =>
        Effect.gen(function* () {
          const startMs = yield* Clock.currentTimeMillis;
          const maybeStream = yield* client.requestRange(entry.request.from, entry.request.to);
          const endMs = yield* Clock.currentTimeMillis;
          yield* Metric.update(blockFetchLatency, endMs - startMs);
          return yield* Option.match(maybeStream, {
            onNone: (): Effect.Effect<FetchBlockRangeResult, BlockFetchError> =>
              Effect.succeed<FetchBlockRangeResult>([]),
            onSome: (stream) => Stream.runCollect(stream).pipe(Effect.mapError(toBlockFetchError)),
          });
        }).pipe(Effect.scoped, Effect.mapError(toBlockFetchError)),
    );

    return RequestResolver.batchN(base, maxInFlight);
  });

/** Handle to the BlockFetch resolver — consumers use `Effect.request(..., resolver)`. */
export class BlockFetchResolver extends Context.Service<
  BlockFetchResolver,
  RequestResolver.RequestResolver<FetchBlockRange>
>()("@harmoniclabs/ouroboros-miniprotocols-ts/BlockFetchResolver") {
  static readonly layer = Layer.effect(BlockFetchResolver, makeResolver());
  static readonly layerWith = (options: { readonly maxInFlight?: number }) =>
    Layer.effect(BlockFetchResolver, makeResolver(options));
}

/**
 * Schema for `FetchBlockRange` — surfaced so test helpers can construct
 * the tagged request without touching the class directly.
 */
export const FetchBlockRangePayload = Schema.Struct({
  from: Schema.Any,
  to: Schema.Any,
});
