/**
 * ChainDB XState machine — orchestrates block processing, immutability, and snapshotting.
 *
 * Uses parallel state regions so block processing and immutability transitions
 * operate independently.
 *
 * Effect-free: the `copying` and `gc` states do not `invoke` anything. They
 * wait for externally-fired completion events (PROMOTE_DONE/FAILED,
 * GC_DONE/FAILED). ChainDBLive observes state via `actor.subscribe` and drives
 * the actual work on an Effect fiber, keeping the XState↔Effect bridge purely
 * event-based (no `Effect.runPromise` inside library code).
 */
import { setup, assign, raise } from "xstate";
import type { RealPoint } from "../types/StoredBlock.ts";
import type { ChainDBEvent } from "./events.ts";

export interface ChainDBContext {
  readonly tip: RealPoint | undefined;
  readonly immutableTip: RealPoint | undefined;
  readonly securityParam: number;
  readonly volatileLength: number;
  readonly lastError: unknown | undefined;
}

export const chainDBMachine = setup({
  types: {} as {
    context: ChainDBContext;
    events: ChainDBEvent;
    input: { securityParam: number };
  },
  guards: {
    shouldCopyToImmutable: ({ context }) =>
      context.tip !== undefined && context.volatileLength > context.securityParam,
  },
}).createMachine({
  id: "chainDB",
  type: "parallel",
  context: ({ input }) => ({
    tip: undefined,
    immutableTip: undefined,
    securityParam: input.securityParam,
    volatileLength: 0,
    lastError: undefined,
  }),
  states: {
    blockProcessing: {
      initial: "idle",
      states: {
        idle: {
          on: {
            BLOCK_ADDED: {
              actions: [
                assign(({ context, event }) => ({
                  ...context,
                  volatileLength: context.volatileLength + 1,
                  tip: event.tip,
                })),
                raise({ type: "IMMUTABILITY_CHECK" }),
              ],
            },
          },
        },
      },
    },
    immutability: {
      initial: "idle",
      states: {
        idle: {
          on: {
            IMMUTABILITY_CHECK: [
              { guard: "shouldCopyToImmutable", target: "copying" },
              { target: "idle" },
            ],
          },
        },
        copying: {
          on: {
            PROMOTE_DONE: {
              target: "gc",
              actions: assign(({ context, event }) => ({
                ...context,
                immutableTip: context.tip,
                volatileLength: Math.max(0, context.volatileLength - event.promoted),
              })),
            },
            PROMOTE_FAILED: {
              target: "idle",
              actions: assign(({ context, event }) => ({
                ...context,
                lastError: event.error,
              })),
            },
          },
        },
        gc: {
          on: {
            GC_DONE: { target: "idle" },
            GC_FAILED: {
              target: "idle",
              actions: assign(({ context, event }) => ({
                ...context,
                lastError: event.error,
              })),
            },
          },
        },
      },
    },
  },
  on: {
    ROLLBACK: {
      actions: assign(({ context, event }) => ({
        ...context,
        tip: event.point,
      })),
    },
    ERROR: {
      actions: assign(({ context, event }) => ({
        ...context,
        lastError: event.error,
      })),
    },
  },
});
