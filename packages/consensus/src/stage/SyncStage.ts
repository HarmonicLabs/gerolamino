/**
 * SyncStage — typed pipeline stage with per-stage metrics, backpressure, and
 * span tracing. Composes into sync-pipelines (ChainSync → HeaderValidate →
 * BlockFetch → BodyValidate → LedgerApply → Persist).
 *
 * Semantic prior art: Amaru's `pure-stage` Rust crate. This is Effect-native:
 * a stage is a typed transformation `Effect<Out, Err, R>` over each input,
 * wrapped with bounded input/output queues (via `Stream`), configurable
 * concurrency, and emission of Metric counters + histograms.
 *
 * API shape:
 *   const headerValidate: SyncStage<HeaderCbor, ValidHeader, HeaderError, Crypto>
 *   runStage(headerValidate, inStream)  // Stream<ValidHeader, HeaderError, Crypto>
 *   connect(headerValidate, bodyFetch)(inStream)
 *
 * Non-goals for this scaffolding: variadic fan-out / fan-in combinators.
 * Add when a Phase 3 consumer needs them; variadic Stream composition
 * typically requires `as T` casts that the project bans.
 */
import { Clock, Data, Effect, Exit, Metric, Stream } from "effect";

export class SyncStage<In, Out, Err, R> extends Data.Class<{
  readonly name: string;
  readonly run: (input: In) => Effect.Effect<Out, Err, R>;
  /**
   * Upper bound on concurrent in-flight invocations of `run`. Maps directly
   * to `Stream.mapEffect({ concurrency })`. Default 1 (sequential).
   */
  readonly concurrency: number;
}> {}

/**
 * Per-stage metric bundle. Instantiated once per `runStage` call — the
 * counter/histogram declarations are idempotent by name, so repeated
 * instantiation across pipeline runs re-uses the same underlying meter.
 */
const stageMetrics = (name: string) =>
  ({
    inCount: Metric.counter(`stage_${name}_in`),
    outCount: Metric.counter(`stage_${name}_out`),
    errCount: Metric.counter(`stage_${name}_err`),
    latencyMs: Metric.histogram(`stage_${name}_latency_ms`, {
      boundaries: [1, 5, 10, 50, 100, 500, 1000, 5000],
    }),
  }) as const;

/**
 * Apply a stage to an input Stream, producing an output Stream. Metrics
 * emit on every item; span opens per item at `stage.${name}`.
 */
export const runStage = <In, Out, Err, R, InErr, InR>(
  stage: SyncStage<In, Out, Err, R>,
  input: Stream.Stream<In, InErr, InR>,
): Stream.Stream<Out, Err | InErr, R | InR> => {
  const m = stageMetrics(stage.name);
  return input.pipe(
    Stream.tap(() => Metric.update(m.inCount, 1)),
    Stream.mapEffect(
      (v) =>
        Effect.gen(function* () {
          const start = yield* Clock.currentTimeMillis;
          return yield* stage.run(v).pipe(
            Effect.withSpan(`stage.${stage.name}`),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const end = yield* Clock.currentTimeMillis;
                yield* Metric.update(m.latencyMs, end - start);
                yield* Metric.update(Exit.isSuccess(exit) ? m.outCount : m.errCount, 1);
              }),
            ),
          );
        }),
      { concurrency: stage.concurrency },
    ),
  );
};

/**
 * Compose two stages left-to-right: `connect(a, b)(input)` runs `a`, feeds
 * its output into `b`. Types align by construction — the output of `a` must
 * match the input of `b`. Error and requirement channels union.
 */
export const connect =
  <A, B, C, E1, E2, R1, R2>(a: SyncStage<A, B, E1, R1>, b: SyncStage<B, C, E2, R2>) =>
  <InErr, InR>(
    input: Stream.Stream<A, InErr, InR>,
  ): Stream.Stream<C, E1 | E2 | InErr, R1 | R2 | InR> =>
    runStage(b, runStage(a, input));
