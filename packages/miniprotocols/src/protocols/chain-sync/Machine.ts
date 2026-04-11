/**
 * ChainSync protocol state machine (XState).
 *
 * Models the Ouroboros ChainSync mini-protocol per the network spec.
 * States: Idle → CanAwait/MustReply → Idle (loop) → Done
 *
 * Agency:
 * - Idle: Client (can send RequestNext, FindIntersect, Done)
 * - CanAwait: Server (sends RollForward, RollBackward, or AwaitReply)
 * - MustReply: Server (must send RollForward or RollBackward)
 * - Intersect: Server (sends IntersectFound or IntersectNotFound)
 * - Done: Terminal
 *
 * Events use Schema.toTaggedUnion("type") for XState compatibility —
 * the "type" discriminator matches XState's event format.
 */
import { Schema } from "effect";
import { setup } from "xstate";

export const ChainSyncState = Schema.Literals([
  "Idle",
  "CanAwait",
  "MustReply",
  "Intersect",
  "Done",
]);
export type ChainSyncState = typeof ChainSyncState.Type;

export const ChainSyncMachineEvent = Schema.Union([
  // Client-initiated (Idle state)
  Schema.Struct({ type: Schema.Literal("CLIENT_REQUEST_NEXT") }),
  Schema.Struct({ type: Schema.Literal("CLIENT_FIND_INTERSECT") }),
  Schema.Struct({ type: Schema.Literal("CLIENT_DONE") }),
  // Server responses (CanAwait/MustReply state)
  Schema.Struct({ type: Schema.Literal("SERVER_ROLL_FORWARD") }),
  Schema.Struct({ type: Schema.Literal("SERVER_ROLL_BACKWARD") }),
  Schema.Struct({ type: Schema.Literal("SERVER_AWAIT_REPLY") }),
  // Server responses (Intersect state)
  Schema.Struct({ type: Schema.Literal("SERVER_INTERSECT_FOUND") }),
  Schema.Struct({ type: Schema.Literal("SERVER_INTERSECT_NOT_FOUND") }),
]).pipe(Schema.toTaggedUnion("type"));

export type ChainSyncMachineEvent = typeof ChainSyncMachineEvent.Type;

export const chainSyncMachine = setup({
  // XState v5 phantom types — value ignored at runtime, used only for TS inference
  types: {} as {
    context: Record<string, never>;
    events: ChainSyncMachineEvent;
  },
}).createMachine({
  id: "chainSync",
  context: {},
  initial: "Idle",
  states: {
    Idle: {
      // Client has agency
      on: {
        CLIENT_REQUEST_NEXT: "CanAwait",
        CLIENT_FIND_INTERSECT: "Intersect",
        CLIENT_DONE: "Done",
      },
    },
    CanAwait: {
      // Server has agency
      on: {
        SERVER_ROLL_FORWARD: "Idle",
        SERVER_ROLL_BACKWARD: "Idle",
        SERVER_AWAIT_REPLY: "MustReply",
      },
    },
    MustReply: {
      // Server has agency (must reply, no AwaitReply allowed)
      on: {
        SERVER_ROLL_FORWARD: "Idle",
        SERVER_ROLL_BACKWARD: "Idle",
      },
    },
    Intersect: {
      // Server has agency
      on: {
        SERVER_INTERSECT_FOUND: "Idle",
        SERVER_INTERSECT_NOT_FOUND: "Idle",
      },
    },
    Done: {
      type: "final" as const,
    },
  },
});
