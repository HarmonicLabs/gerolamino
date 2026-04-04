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
 */
import { setup } from "xstate";

export type ChainSyncState = "Idle" | "CanAwait" | "MustReply" | "Intersect" | "Done";

export type ChainSyncMachineEvent =
  // Client-initiated (Idle state)
  | { readonly type: "CLIENT_REQUEST_NEXT" }
  | { readonly type: "CLIENT_FIND_INTERSECT" }
  | { readonly type: "CLIENT_DONE" }
  // Server responses (CanAwait/MustReply state)
  | { readonly type: "SERVER_ROLL_FORWARD" }
  | { readonly type: "SERVER_ROLL_BACKWARD" }
  | { readonly type: "SERVER_AWAIT_REPLY" }
  // Server responses (Intersect state)
  | { readonly type: "SERVER_INTERSECT_FOUND" }
  | { readonly type: "SERVER_INTERSECT_NOT_FOUND" };

export const chainSyncMachine = setup({
  types: {
    context: {} as Record<string, never>,
    events: {} as ChainSyncMachineEvent,
  },
}).createMachine({
  id: "chainSync",
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
