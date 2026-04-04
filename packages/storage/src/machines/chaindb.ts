/**
 * ChainDB XState machine — orchestrates block processing, immutability, and snapshotting.
 *
 * Uses parallel state regions so block processing, immutability transitions,
 * and snapshot writing operate independently.
 *
 * Side effects are expressed as Effect values via enqueue.effect(),
 * executed by the runtime after state transitions.
 */
import { setup, assign, fromPromise } from "xstate";
import type { RealPoint, StoredBlock } from "../types/StoredBlock.ts";
import type { ChainDBEvent } from "./events.ts";

export interface ChainDBContext {
  readonly tip: RealPoint | undefined;
  readonly immutableTip: RealPoint | undefined;
  readonly securityParam: number;
  readonly volatileLength: number;
  readonly lastError: unknown | undefined;
}

export const chainDBMachine = setup({
  types: {
    context: {} as ChainDBContext,
    events: {} as ChainDBEvent,
    input: {} as { securityParam: number },
  },
  guards: {
    shouldCopyToImmutable: ({ context }) =>
      context.volatileLength > context.securityParam,
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
            BLOCK_RECEIVED: {
              target: "received",
              actions: assign(({ context }) => ({
                ...context,
                volatileLength: context.volatileLength + 1,
              })),
            },
          },
        },
        received: {
          on: {
            CHAIN_SELECTED: {
              target: "idle",
              actions: assign(({ context, event }) => ({
                ...context,
                tip: event.tip,
              })),
            },
            ERROR: {
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
            COPY_COMPLETE: "gc",
          },
        },
        gc: {
          on: {
            GC_COMPLETE: {
              target: "idle",
              actions: assign(({ context }) => ({
                ...context,
                volatileLength: Math.max(0, context.volatileLength - 1),
              })),
            },
          },
        },
      },
    },
    snapshotting: {
      initial: "idle",
      states: {
        idle: {
          on: {
            SNAPSHOT_WRITTEN: "idle",
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
