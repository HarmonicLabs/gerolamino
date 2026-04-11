/**
 * Cardano slot clock — maps wall-clock time to blockchain slots and epochs.
 *
 * Uses Effect's Clock service for wall-clock access (testable via TestClock).
 * No platform-specific code — Clock adapts internally to Bun/Node/Browser.
 *
 * Node parameters are configurable via Effect Config module:
 *   CARDANO_SYSTEM_START_MS, CARDANO_SLOT_LENGTH_MS, CARDANO_EPOCH_LENGTH,
 *   CARDANO_SECURITY_PARAM, CARDANO_ACTIVE_SLOTS_COEFF
 *
 * Cardano time model:
 *   - Slot 0 starts at systemStart (genesis timestamp)
 *   - Each slot is exactly slotLength seconds
 *   - Epoch has epochLength slots
 *   - Slot → epoch: floor(slot / epochLength)
 */
import { Clock, Config, Effect, Schema, ServiceMap } from "effect";

/** Cardano network time parameters. */
export class SlotConfig extends Schema.TaggedClass<SlotConfig>()("SlotConfig", {
  /** Unix timestamp (milliseconds) of slot 0. */
  systemStartMs: Schema.Number,
  /** Slot duration in milliseconds. */
  slotLengthMs: Schema.Number,
  /** Slots per epoch. */
  epochLength: Schema.BigInt,
  /** Security parameter k. */
  securityParam: Schema.Number,
  /** Active slots coefficient f. */
  activeSlotsCoeff: Schema.Number,
}) {}

/** Read SlotConfig from Effect Config (environment variables). */
export const SlotConfigFromEnv = Config.all({
  systemStartMs: Config.number("CARDANO_SYSTEM_START_MS"),
  slotLengthMs: Config.number("CARDANO_SLOT_LENGTH_MS").pipe(
    Config.withDefault(1000),
  ),
  epochLength: Config.number("CARDANO_EPOCH_LENGTH").pipe(
    Config.withDefault(432000),
  ),
  securityParam: Config.number("CARDANO_SECURITY_PARAM").pipe(
    Config.withDefault(2160),
  ),
  activeSlotsCoeff: Config.number("CARDANO_ACTIVE_SLOTS_COEFF").pipe(
    Config.withDefault(0.05),
  ),
}).pipe(
  Config.map((c) =>
    new SlotConfig({
      systemStartMs: c.systemStartMs,
      slotLengthMs: c.slotLengthMs,
      epochLength: BigInt(c.epochLength),
      securityParam: c.securityParam,
      activeSlotsCoeff: c.activeSlotsCoeff,
    }),
  ),
);

/** Preprod network config (hardcoded fallback). */
export const PREPROD_CONFIG = new SlotConfig({
  systemStartMs: 1654041600000, // 2022-06-01T00:00:00Z
  slotLengthMs: 1000,
  epochLength: 432000n,
  securityParam: 2160,
  activeSlotsCoeff: 0.05,
});

/** Mainnet config (hardcoded fallback). */
export const MAINNET_CONFIG = new SlotConfig({
  systemStartMs: 1596491091000, // 2020-08-03T21:44:51Z
  slotLengthMs: 1000,
  epochLength: 432000n,
  securityParam: 2160,
  activeSlotsCoeff: 0.05,
});

export class SlotClock extends ServiceMap.Service<
  SlotClock,
  {
    readonly currentSlot: Effect.Effect<bigint>;
    readonly currentEpoch: Effect.Effect<bigint>;
    readonly slotInEpoch: Effect.Effect<bigint>;
    readonly slotToMs: (slot: bigint) => number;
    readonly msToSlot: (ms: number) => bigint;
    readonly slotToEpoch: (slot: bigint) => bigint;
    readonly slotWithinEpoch: (slot: bigint) => bigint;
    /** Stability window: 3k/f slots. */
    readonly stabilityWindow: bigint;
    /** Randomness stabilization: 8k/f slots. Candidate nonce freezes here. */
    readonly randomnessStabilizationWindow: bigint;
    /** Candidate collection period: 16k/f slots. */
    readonly candidateCollectionEnd: bigint;
    readonly config: SlotConfig;
  }
>()("consensus/SlotClock") {}

/** Build SlotClock from explicit config. Uses Effect's Clock for wall-clock. */
export const SlotClockLive = (config: SlotConfig) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;

    const msToSlot = (ms: number): bigint => {
      const elapsed = ms - config.systemStartMs;
      if (elapsed < 0) return 0n;
      return BigInt(Math.floor(elapsed / config.slotLengthMs));
    };

    const slotToMs = (slot: bigint): number =>
      config.systemStartMs + Number(slot) * config.slotLengthMs;

    const slotToEpoch = (slot: bigint): bigint => slot / config.epochLength;
    const slotWithinEpoch = (slot: bigint): bigint => slot % config.epochLength;

    const k = config.securityParam;
    const f = config.activeSlotsCoeff;

    return {
      currentSlot: clock.currentTimeMillis.pipe(Effect.map((ms) => msToSlot(Number(ms)))),
      currentEpoch: clock.currentTimeMillis.pipe(Effect.map((ms) => slotToEpoch(msToSlot(Number(ms))))),
      slotInEpoch: clock.currentTimeMillis.pipe(Effect.map((ms) => slotWithinEpoch(msToSlot(Number(ms))))),
      slotToMs,
      msToSlot,
      slotToEpoch,
      slotWithinEpoch,
      stabilityWindow: BigInt(Math.ceil((3 * k) / f)),
      randomnessStabilizationWindow: BigInt(Math.ceil((4 * k) / f)),
      candidateCollectionEnd: config.epochLength - BigInt(Math.ceil((4 * k) / f)),
      config,
    };
  });

/**
 * SlotClock layer from environment Config.
 * Reads CARDANO_SYSTEM_START_MS etc. from the environment.
 * Falls back to preprod defaults for optional params.
 */
export const SlotClockLayerFromConfig = Effect.gen(function* () {
  const config = yield* SlotConfigFromEnv;
  return yield* SlotClockLive(config);
});
