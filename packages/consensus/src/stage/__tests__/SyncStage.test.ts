import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Stream } from "effect";
import { SyncStage, connect, runStage } from "../SyncStage.ts";

const double = new SyncStage<number, number, never, never>({
  name: "double",
  run: (n) => Effect.succeed(n * 2),
  concurrency: 1,
});

const add10 = new SyncStage<number, number, never, never>({
  name: "add10",
  run: (n) => Effect.succeed(n + 10),
  concurrency: 1,
});

const maybeFail = new SyncStage<number, number, string, never>({
  name: "maybeFail",
  run: (n) => (n < 0 ? Effect.fail(`negative: ${n}`) : Effect.succeed(n)),
  concurrency: 1,
});

const parallelDouble = new SyncStage<number, number, never, never>({
  name: "parallelDouble",
  run: (n) => Effect.succeed(n * 2),
  concurrency: 4,
});

describe("SyncStage", () => {
  it.effect("runStage applies the transform to each item", () =>
    Effect.gen(function* () {
      const result = yield* Stream.runCollect(runStage(double, Stream.range(1, 5)));
      expect(result).toEqual([2, 4, 6, 8, 10]);
    }),
  );

  it.effect("connect composes stages left-to-right", () =>
    Effect.gen(function* () {
      const pipeline = connect(double, add10);
      const result = yield* Stream.runCollect(pipeline(Stream.range(1, 3)));
      // 1→2→12; 2→4→14; 3→6→16
      expect(result).toEqual([12, 14, 16]);
    }),
  );

  it.effect("stage errors propagate through the stream", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Stream.runCollect(runStage(maybeFail, Stream.fromIterable([1, -2, 3]))),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("concurrency > 1 preserves output order by default", () =>
    Effect.gen(function* () {
      // `Stream.mapEffect` without `unordered: true` preserves order even at
      // concurrency > 1 — the plan relies on this for header-validate stages.
      const result = yield* Stream.runCollect(runStage(parallelDouble, Stream.range(1, 10)));
      expect(result).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    }),
  );

  it.effect("composition handles empty streams", () =>
    Effect.gen(function* () {
      const pipeline = connect(double, add10);
      const result = yield* Stream.runCollect(pipeline(Stream.empty));
      expect(result).toEqual([]);
    }),
  );
});
