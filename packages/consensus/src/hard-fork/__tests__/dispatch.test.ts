import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Ref } from "effect";
import { Era } from "ledger/lib/core/era.ts";
import { dispatchByEra, type EraValidators } from "../dispatch.ts";

// Tests exercise the pure-era `dispatchByEra` primitive. Full-block
// routing via `validateBlockByEra` is covered at the integration level
// once real consensus rules land; unit-testing that path requires
// constructing Schema-valid `MultiEraBlock` values, which is heavyweight
// and doesn't add coverage beyond `dispatchByEra` + `MultiEraBlock.match`.

const mkLoggingValidators = (log: Ref.Ref<string[]>): EraValidators<"_", never, never> => ({
  byron: () => Ref.update(log, (xs) => [...xs, "byron"]),
  shelley: () => Ref.update(log, (xs) => [...xs, "shelley"]),
  allegra: () => Ref.update(log, (xs) => [...xs, "allegra"]),
  mary: () => Ref.update(log, (xs) => [...xs, "mary"]),
  alonzo: () => Ref.update(log, (xs) => [...xs, "alonzo"]),
  babbage: () => Ref.update(log, (xs) => [...xs, "babbage"]),
  conway: () => Ref.update(log, (xs) => [...xs, "conway"]),
});

describe("hard-fork/dispatch", () => {
  it.effect("dispatchByEra(Shelley, ...) fires the shelley validator", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<string[]>([]);
      yield* dispatchByEra(Era.Shelley, "_", mkLoggingValidators(log));
      expect(yield* Ref.get(log)).toEqual(["shelley"]);
    }),
  );

  it.effect("dispatchByEra(Conway, ...) fires the conway validator", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<string[]>([]);
      yield* dispatchByEra(Era.Conway, "_", mkLoggingValidators(log));
      expect(yield* Ref.get(log)).toEqual(["conway"]);
    }),
  );

  it.effect("dispatchByEra routes every live era to the right callback", () =>
    Effect.gen(function* () {
      const eras: ReadonlyArray<[Era, string]> = [
        [Era.Byron, "byron"],
        [Era.Shelley, "shelley"],
        [Era.Allegra, "allegra"],
        [Era.Mary, "mary"],
        [Era.Alonzo, "alonzo"],
        [Era.Babbage, "babbage"],
        [Era.Conway, "conway"],
      ];
      for (const [era, expected] of eras) {
        const log = yield* Ref.make<string[]>([]);
        yield* dispatchByEra(era, "_", mkLoggingValidators(log));
        expect(yield* Ref.get(log)).toEqual([expected]);
      }
    }),
  );

  it.effect("dispatchByEra(Byron, ...) with no byron validator no-ops", () =>
    Effect.gen(function* () {
      const log = yield* Ref.make<string[]>([]);
      const noByron: EraValidators<"_", never, never> = {
        // byron intentionally omitted
        shelley: () => Ref.update(log, (xs) => [...xs, "shelley"]),
        allegra: () => Ref.update(log, (xs) => [...xs, "allegra"]),
        mary: () => Ref.update(log, (xs) => [...xs, "mary"]),
        alonzo: () => Ref.update(log, (xs) => [...xs, "alonzo"]),
        babbage: () => Ref.update(log, (xs) => [...xs, "babbage"]),
        conway: () => Ref.update(log, (xs) => [...xs, "conway"]),
      };
      yield* dispatchByEra(Era.Byron, "_", noByron);
      expect(yield* Ref.get(log)).toEqual([]);
    }),
  );

  it.effect("dispatchByEra propagates validator errors", () =>
    Effect.gen(function* () {
      class ShelleyBroken extends Error {}
      const validators: EraValidators<"_", ShelleyBroken, never> = {
        byron: () => Effect.void,
        shelley: () => Effect.fail(new ShelleyBroken()),
        allegra: () => Effect.void,
        mary: () => Effect.void,
        alonzo: () => Effect.void,
        babbage: () => Effect.void,
        conway: () => Effect.void,
      };
      const exit = yield* Effect.exit(dispatchByEra(Era.Shelley, "_", validators));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("dispatchByEra passes the input through to the selected validator", () =>
    Effect.gen(function* () {
      const received = yield* Ref.make<number | null>(null);
      const validators: EraValidators<number, never, never> = {
        byron: (n) => Ref.set(received, n),
        shelley: (n) => Ref.set(received, n),
        allegra: (n) => Ref.set(received, n),
        mary: (n) => Ref.set(received, n),
        alonzo: (n) => Ref.set(received, n),
        babbage: (n) => Ref.set(received, n),
        conway: (n) => Ref.set(received, n),
      };
      yield* dispatchByEra(Era.Conway, 42, validators);
      expect(yield* Ref.get(received)).toBe(42);
    }),
  );
});
