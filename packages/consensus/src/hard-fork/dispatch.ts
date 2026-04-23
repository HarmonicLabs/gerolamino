/**
 * Era-dispatch layer — routes block validation to era-specific handlers.
 *
 * Per wave-2 Haskell research (Phase 3h Correction #9): era transitions
 * happen during **tick** (at slot boundaries), not between block
 * applications. So dispatch doesn't need to compute "what era
 * transitioned in" — the ledger state passed to the validator is already
 * in the correct era (translated at tick-time by a caller using
 * `eraAtSlot` + the still-deferred `translate_{from}_{to}` family).
 *
 * Split into two layers:
 *   1. `dispatchByEra(era, validators)` — pure routing over an `Era`.
 *      Easy to test without constructing full `MultiEraBlock` values.
 *   2. `validateBlockByEra(history, block, validators, slot?)` — extracts
 *      `era` from a `MultiEraBlock` (via `MultiEraBlock.match`) + validates
 *      against `eraAtSlot(history, slot)` when slot is provided.
 *
 * This is the plan's intended DI shape so future consensus.rules modules
 * can drop in without touching the routing layer.
 */
import { Effect, Schema } from "effect";
import { MultiEraBlock } from "ledger/lib/block/block.ts";
import { Era } from "ledger/lib/core/era.ts";
import { type EraHistory, eraAtSlot } from "./era-transition.ts";

/**
 * Structured failure type for dispatch errors that are purely structural
 * (unreachable era, history inconsistency). Era-specific validation
 * failures come from the injected validator callbacks.
 */
export class EraDispatchError extends Schema.TaggedErrorClass<EraDispatchError>()(
  "EraDispatchError",
  {
    message: Schema.String,
    era: Schema.optional(Schema.Enum(Era)),
  },
) {}

/**
 * Per-era validator callbacks. Byron is validation-opt-out (blocks
 * pre-validated into ImmutableDB from the Mithril snapshot); callers can
 * leave the Byron callback unset and dispatch will accept Byron blocks
 * without running any rule.
 *
 * The `Input` type parameter is what each validator receives — typically
 * `MultiEraBlock`, but callers can pass lighter shapes (e.g. a decoded
 * `BlockHeader`) when only a subset of validation is routed.
 */
export interface EraValidators<Input, Err, R> {
  readonly byron?: ((input: Input) => Effect.Effect<void, Err, R>) | undefined;
  readonly shelley: (input: Input) => Effect.Effect<void, Err, R>;
  readonly allegra: (input: Input) => Effect.Effect<void, Err, R>;
  readonly mary: (input: Input) => Effect.Effect<void, Err, R>;
  readonly alonzo: (input: Input) => Effect.Effect<void, Err, R>;
  readonly babbage: (input: Input) => Effect.Effect<void, Err, R>;
  readonly conway: (input: Input) => Effect.Effect<void, Err, R>;
}

/**
 * Route an input to the validator for a given era. Pure over the `Era` +
 * callbacks — doesn't know or care what the `Input` is.
 */
export const dispatchByEra = <Input, Err, R>(
  era: Era,
  input: Input,
  validators: EraValidators<Input, Err, R>,
): Effect.Effect<void, Err, R> => {
  switch (era) {
    case Era.Byron:
      return validators.byron === undefined ? Effect.void : validators.byron(input);
    case Era.Shelley:
      return validators.shelley(input);
    case Era.Allegra:
      return validators.allegra(input);
    case Era.Mary:
      return validators.mary(input);
    case Era.Alonzo:
      return validators.alonzo(input);
    case Era.Babbage:
      return validators.babbage(input);
    case Era.Conway:
      return validators.conway(input);
  }
};

/**
 * Extract the effective era for a block. Post-Byron blocks carry their
 * era in the header (`block.era`); Byron blocks are always Byron.
 */
export const eraOfBlock = (block: MultiEraBlock): Era =>
  MultiEraBlock.match(block, {
    byron: () => Era.Byron,
    postByron: ({ era }) => era,
  });

/**
 * Route a block to its era-specific validator. Optionally cross-check
 * against `eraHistory` + `slot` — when provided, the block's intrinsic
 * era tag must match `eraAtSlot(history, slot)`. A mismatch indicates a
 * fork-forked-into-wrong-era state (caller should reject / resync).
 */
export const validateBlockByEra = <Err, R>(
  history: EraHistory,
  block: MultiEraBlock,
  validators: EraValidators<MultiEraBlock, Err, R>,
  slot?: bigint,
): Effect.Effect<void, Err | EraDispatchError, R> =>
  Effect.gen(function* () {
    const blockEra = eraOfBlock(block);
    if (slot !== undefined) {
      const historyEra = eraAtSlot(history, slot);
      if (historyEra !== blockEra) {
        return yield* Effect.fail(
          new EraDispatchError({
            message: `Block era (${Era[blockEra]}) disagrees with EraHistory's era at slot ${slot} (${Era[historyEra]})`,
            era: blockEra,
          }),
        );
      }
    }
    return yield* dispatchByEra(blockEra, block, validators);
  });
