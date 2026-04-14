/**
 * ChainDB XState machine — orchestrates block processing, immutability, and snapshotting.
 *
 * Uses parallel state regions so block processing and immutability transitions
 * operate independently.
 *
 * Lifecycle states (`copying`, `gc`) use XState `invoke` with `fromPromise`
 * actors. The machine definition uses placeholder actors — real implementations
 * are provided at runtime via `machine.provide({ actors: { ... } })` in
 * ChainDBLive, bridging to Effect via ManagedRuntime.
 */
import { setup, assign, raise, fromPromise } from "xstate";
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
  actors: {
    promoteBlocks: fromPromise<number, { tip: RealPoint }>(async () => 0),
    collectGarbage: fromPromise<void, { belowSlot: bigint }>(async () => {}),
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
          invoke: {
            src: "promoteBlocks",
            input: ({ context }) => ({ tip: context.tip! }),
            onDone: {
              target: "gc",
              actions: assign(({ context, event }) => ({
                ...context,
                immutableTip: context.tip,
                volatileLength: Math.max(0, context.volatileLength - (event.output ?? 0)),
              })),
            },
            onError: {
              target: "idle",
              actions: assign(({ context, event }) => ({
                ...context,
                lastError: "error" in event ? event.error : event,
              })),
            },
          },
        },
        gc: {
          invoke: {
            src: "collectGarbage",
            input: ({ context }) => ({
              belowSlot: context.immutableTip?.slot ?? 0n,
            }),
            onDone: {
              target: "idle",
            },
            onError: {
              target: "idle",
              actions: assign(({ context, event }) => ({
                ...context,
                lastError: "error" in event ? event.error : event,
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
