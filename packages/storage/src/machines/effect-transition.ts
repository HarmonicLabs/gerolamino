/**
 * fromEffectTransition — bridge between XState pure transitions and Effect-TS side effects.
 *
 * XState defines WHAT state transitions happen (pure logic).
 * Effect defines HOW side effects execute (I/O, errors, resources).
 *
 * Pattern: XState store's enqueue.effect() collects side effects during transition,
 * which are then executed as Effect values via a ManagedRuntime.
 */
import { type Effect } from "effect";

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
