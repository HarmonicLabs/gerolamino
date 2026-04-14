/**
 * fromEffectTransition — bridge between XState pure transitions and Effect-TS side effects.
 *
 * XState defines WHAT state transitions happen (pure logic).
 * Effect defines HOW side effects execute (I/O, errors, resources).
 *
 * Two bridge patterns:
 *
 * 1. `EffectTransition` — for @xstate/store: returns [nextContext, effects[]]
 * 2. `fromEffectActor` — for XState `invoke`: creates a `fromPromise` actor
 *    that runs an Effect program via a ManagedRuntime. Use with `machine.provide()`
 *    to inject real implementations at construction time.
 */
import { type Effect, type ManagedRuntime } from "effect";
import { fromPromise } from "xstate";

/**
 * A transition function that returns the next state AND a list of Effects to execute.
 */
export type EffectTransition<TContext, TEvent> = (
  context: TContext,
  event: TEvent,
) => readonly [nextContext: TContext, effects: ReadonlyArray<Effect.Effect<void, unknown>>];

/**
 * Wraps an EffectTransition into a structure usable by XState stores.
 *
 * The `execute` function runs all collected effects sequentially after state update.
 */
export function fromEffectTransition<TContext, TEvent>(
  transition: EffectTransition<TContext, TEvent>,
  initialContext: TContext,
) {
  return {
    transition,
    initialContext,
  };
}

/**
 * Create an XState `fromPromise` actor that runs an Effect program via ManagedRuntime.
 *
 * Use this to bridge XState `invoke` states to Effect-TS side effects:
 *
 *   const providedMachine = machine.provide({
 *     actors: {
 *       promoteBlocks: fromEffectActor(runtime, (input) => promoteEffect(input.tip)),
 *     },
 *   });
 *
 * The ManagedRuntime provides all required Effect services (BlobStore, SqlClient, etc.).
 */
export function fromEffectActor<I, O, R, E>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
  effect: (input: I) => Effect.Effect<O, unknown, R>,
) {
  return fromPromise<O, I>(({ input }) => runtime.runPromise(effect(input)));
}
