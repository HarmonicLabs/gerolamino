import { describe, it, expect } from "vitest";
import { Clock, Effect, Layer } from "effect";
import { SlotClock, SlotClockLive, PREPROD_CONFIG, SlotConfig } from "../clock";

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

const run = <A>(ms: number, effect: Effect.Effect<A, unknown, SlotClock>) =>
  effect.pipe(Effect.provide(withClockAt(ms)), Effect.runPromise);

describe("SlotClock", () => {
  it("slot 0 at system start", async () => {
    const slot = await run(
      0,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        return yield* clock.currentSlot;
      }),
    );
    expect(slot).toBe(0n);
  });

  it("slot 1 after 1 second", async () => {
    const slot = await run(
      1000,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        return yield* clock.currentSlot;
      }),
    );
    expect(slot).toBe(1n);
  });

  it("slot 99 at end of first epoch", async () => {
    const slot = await run(
      99_000,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        return yield* clock.currentSlot;
      }),
    );
    expect(slot).toBe(99n);
  });

  it("epoch 1 starts at slot 100", async () => {
    const result = await run(
      100_000,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        return {
          slot: yield* clock.currentSlot,
          epoch: yield* clock.currentEpoch,
          slotInEpoch: yield* clock.slotInEpoch,
        };
      }),
    );
    expect(result.slot).toBe(100n);
    expect(result.epoch).toBe(1n);
    expect(result.slotInEpoch).toBe(0n);
  });

  it("returns 0 for time before system start", async () => {
    const slot = await run(
      -5000,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        return yield* clock.currentSlot;
      }),
    );
    expect(slot).toBe(0n);
  });

  it("slotToMs is inverse of msToSlot", async () => {
    const result = await run(
      42_500,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        const slot = clock.msToSlot(42_500);
        const ms = clock.slotToMs(slot);
        return { slot, ms };
      }),
    );
    expect(result.slot).toBe(42n);
    expect(result.ms).toBe(42_000); // floor of 42.5s
  });

  it("stability window is 3k/f", async () => {
    const sw = await run(
      0,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        return clock.stabilityWindow;
      }),
    );
    // k=10, f=0.5 → ceil(3*10/0.5) = 60
    expect(sw).toBe(60n);
  });

  it("randomness stabilization window is 4k/f", async () => {
    const rsw = await run(
      0,
      Effect.gen(function* () {
        const clock = yield* SlotClock;
        return clock.randomnessStabilizationWindow;
      }),
    );
    // k=10, f=0.5 → ceil(4*10/0.5) = 80
    expect(rsw).toBe(80n);
  });

  it("works with preprod config", async () => {
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
    const result = await Effect.gen(function* () {
      const clock = yield* SlotClock;
      return {
        slot: yield* clock.currentSlot,
        epoch: yield* clock.currentEpoch,
      };
    }).pipe(Effect.provide(layer), Effect.runPromise);
    expect(result.slot).toBe(432_000n);
    expect(result.epoch).toBe(1n);
  });
});
