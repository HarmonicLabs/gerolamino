/**
 * Relay lifecycle XState machine — manages the upstream relay connection.
 *
 * States:
 *   disconnected → syncing → reconnecting → syncing → ...
 *                     ↑          |
 *                     └──────────┘ (after exponential backoff)
 *
 * The `connectAndSync` invoke actor runs the full N2N stack:
 *   Socket → Multiplexer → Handshake → ChainSync + KeepAlive
 *
 * When the sync connection drops (socket error, protocol error), the machine
 * transitions to `reconnecting` with exponential backoff (1s → 2s → ... → 60s max,
 * ±25% jitter). The retry counter resets on successful connection.
 *
 * Consumers subscribe to the actor for state visibility (UI, monitoring).
 * The machine is pure — real implementations provided via `machine.provide()`.
 */
import { Schema } from "effect";
import { setup, assign, fromPromise } from "xstate";

export interface RelayContext {
  readonly peerId: string;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly lastError: unknown | undefined;
}

export const RelayEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("CONNECT") }),
  Schema.Struct({ type: Schema.Literal("DISCONNECT") }),
]).pipe(Schema.toTaggedUnion("type"));

export type RelayEvent = typeof RelayEvent.Type;

export const relayMachine = setup({
  // XState v5 phantom types — value ignored at runtime, used only for TS inference
  types: {} as {
    context: RelayContext;
    events: RelayEvent;
    input: { peerId: string; maxRetries?: number };
  },
  actors: {
    /** Full N2N connection: handshake + ChainSync + KeepAlive. Replaced via .provide(). */
    connectAndSync: fromPromise<void, { peerId: string }>(async () => {}),
  },
  delays: {
    /** Exponential backoff: 1s × 2^retryCount, capped at 60s, ±25% jitter. */
    reconnectDelay: ({ context }) => {
      const base = Math.min(1000 * Math.pow(2, context.retryCount), 60_000);
      const jitter = base * 0.25 * (Math.random() * 2 - 1);
      return Math.max(100, Math.floor(base + jitter));
    },
  },
  guards: {
    canRetry: ({ context }) => context.retryCount < context.maxRetries,
  },
}).createMachine({
  id: "relay",
  initial: "disconnected",
  context: ({ input }) => ({
    peerId: input.peerId,
    retryCount: 0,
    maxRetries: input.maxRetries ?? 100,
    lastError: undefined,
  }),
  states: {
    disconnected: {
      on: {
        CONNECT: "syncing",
      },
    },
    syncing: {
      invoke: {
        src: "connectAndSync",
        input: ({ context }) => ({ peerId: context.peerId }),
        onDone: {
          // Sync loop completed normally (unusual — means connection closed cleanly)
          target: "disconnected",
          actions: assign(({ context }) => ({
            ...context,
            retryCount: 0,
            lastError: undefined,
          })),
        },
        onError: [
          {
            guard: "canRetry",
            target: "reconnecting",
            actions: assign(({ context, event }) => ({
              ...context,
              lastError: "error" in event ? event.error : event,
              retryCount: context.retryCount + 1,
            })),
          },
          {
            target: "disconnected",
            actions: assign(({ context, event }) => ({
              ...context,
              lastError: "error" in event ? event.error : event,
            })),
          },
        ],
      },
      on: {
        DISCONNECT: "disconnected",
      },
    },
    reconnecting: {
      after: {
        reconnectDelay: "syncing",
      },
      on: {
        DISCONNECT: "disconnected",
      },
    },
  },
});
