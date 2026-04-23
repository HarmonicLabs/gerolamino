import { describe, it, expect } from "@effect/vitest";
import { Clock, Effect, Layer } from "effect";
import { SlotClock, SlotClockLive, PREPROD_CONFIG, SlotConfig } from "../praos/clock";

/** Test config: system start at epoch 0, 1s slots, 100 slots per epoch. */
const TEST_CONFIG = new SlotConfig({
  systemStartMs: 0, // epoch 0 = Unix epoch for easy math
  slotLengthMs: 1000,
  epochLength: 100n,
  securityParam: 10,
  activeSlotsCoeff: 0.5,
  byronEpochLength: 4320n,
});

/** Create a test layer with a fixed clock time. */
const withClockAt = (ms: number) => {
  const fixedClock: Clock.Clock = {
    currentTimeMillisUnsafe: () => ms,
    currentTimeMillis: Effect.sync(() => ms),
    currentTimeNanosUnsafe: () => BigInt(ms) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(ms) * 1_000_000n),
    sleep: () => Effect.void,
  };
  return Layer.effect(
    SlotClock,
    SlotClockLive(TEST_CONFIG).pipe(Effect.provideService(Clock.Clock, fixedClock)),
  );
};

const provide = <A>(ms: number, effect: Effect.Effect<A, unknown, SlotClock>) =>
  effect.pipe(Effect.provide(withClockAt(ms)));

describe("SlotClock", () => {
  it.effect("slot 0 at system start", () =>
    provide(
      0,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        const slot = yield* clock.currentSlot;
        expect(slot).toBe(0n);
      }),
    ),
  );

  it.effect("slot 1 after 1 second", () =>
    provide(
      1000,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        const slot = yield* clock.currentSlot;
        expect(slot).toBe(1n);
      }),
    ),
  );

  it.effect("slot 99 at end of first epoch", () =>
    provide(
      99_000,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        const slot = yield* clock.currentSlot;
        expect(slot).toBe(99n);
      }),
    ),
  );

  it.effect("epoch 1 starts at slot 100", () =>
    provide(
      100_000,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        const slot = yield* clock.currentSlot;
        const epoch = yield* clock.currentEpoch;
        const slotInEpoch = yield* clock.slotInEpoch;
        expect(slot).toBe(100n);
        expect(epoch).toBe(1n);
        expect(slotInEpoch).toBe(0n);
      }),
    ),
  );

  it.effect("returns 0 for time before system start", () =>
    provide(
      -5000,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        const slot = yield* clock.currentSlot;
        expect(slot).toBe(0n);
      }),
    ),
  );

  it.effect("slotToMs is inverse of msToSlot", () =>
    provide(
      42_500,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        const slot = clock.msToSlot(42_500);
        const ms = clock.slotToMs(slot);
        expect(slot).toBe(42n);
        expect(ms).toBe(42_000); // floor of 42.5s
      }),
    ),
  );

  it.effect("stability window is 3k/f", () =>
    provide(
      0,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        const sw = clock.stabilityWindow;
        // k=10, f=0.5 → ceil(3*10/0.5) = 60
        expect(sw).toBe(60n);
      }),
    ),
  );

  it.effect("randomness stabilization window is 4k/f", () =>
    provide(
      0,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        const rsw = clock.randomnessStabilizationWindow;
        // k=10, f=0.5 → ceil(4*10/0.5) = 80
        expect(rsw).toBe(80n);
      }),
    ),
  );

  it.effect("works with preprod config", () => {
    // Preprod system start: 2022-06-01T00:00:00Z = 1654041600000
    const now = 1654041600000 + 432_000_000; // exactly 1 epoch later
    const layer = Layer.effect(
      SlotClock,
      SlotClockLive(PREPROD_CONFIG).pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeMillisUnsafe: () => now,
          currentTimeMillis: Effect.sync(() => now),
          currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
          currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
          sleep: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const clock = yield* SlotClock;
      const slot = yield* clock.currentSlot;
      const epoch = yield* clock.currentEpoch;
      expect(slot).toBe(432_000n);
      expect(epoch).toBe(1n);
    }).pipe(Effect.provide(layer));
  });
});
