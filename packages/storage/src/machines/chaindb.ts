/**
 * ChainDB XState machine — orchestrates block processing, immutability, and snapshotting.
 *
 * Uses parallel state regions so block processing, immutability transitions,
 * and snapshot writing operate independently.
 *
 * Lifecycle states (`copying`, `gc`) use XState `invoke` with `fromPromise`
 * actors. The machine definition uses placeholder actors — real implementations
 * are provided at runtime via `machine.provide({ actors: { ... } })` in
 * ChainDBLive, bridging to Effect via ManagedRuntime.
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
  // XState v5 phantom types — value ignored at runtime, used only for TS inference
  types: {} as {
    context: ChainDBContext;
    events: ChainDBEvent;
    input: { securityParam: number };
  },
  guards: {
    shouldCopyToImmutable: ({ context }) => context.volatileLength > context.securityParam,
  },
  actors: {
    /** Promote volatile blocks to immutable. Returns count of promoted blocks. Replaced at runtime via .provide(). */
    promoteBlocks: fromPromise<number, { tip: RealPoint }>(async () => 0),
    /** Garbage-collect stale volatile blocks. Replaced at runtime via .provide(). */
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
          on: {
            // Keep manual event for tests that don't provide real actors
            COPY_COMPLETE: "gc",
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
          on: {
            // Keep manual event for tests that don't provide real actors
            GC_COMPLETE: {
              target: "idle",
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
