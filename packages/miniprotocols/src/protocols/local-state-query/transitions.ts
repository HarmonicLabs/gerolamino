/**
 * LocalStateQuery agency table — Ouroboros network-spec §5.
 *
 *        Client has agency                Server has agency
 *        ─────────────────                ─────────────────
 *
 *              Idle  ──MsgAcquire──►  Acquiring
 *              Acquired ◄─MsgAcquired─ Acquiring
 *              Idle  ◄──MsgFailure──  Acquiring
 *              Acquired ──MsgQuery──► Querying
 *              Acquired ◄─MsgResult── Querying
 *              Acquiring ◄─MsgReAcquire─ Acquired
 *              Idle  ◄──MsgRelease── Acquired
 *              Done  ──MsgDone──►  Done
 *              Done  (Neither — terminal)
 *
 * Full `AnyQuery` tagged-union dispatch lands with Phase 3h (Hard Fork
 * Combinator) era-dependent query shapes. Until then the query payload
 * is carried as opaque bytes — the transition table enforces the envelope
 * semantics (when you can send a query, when you must wait for a result).
 */
import { ProtocolState, filteredCodec } from "../../typed-channel";
import type { Transition } from "../../typed-channel";
import { LocalStateQueryMessageBytes, LocalStateQueryMessageType } from "./Schemas";
import type { LocalStateQueryMessageT } from "./Schemas";

type Narrow<Tag extends LocalStateQueryMessageType> = Extract<
  LocalStateQueryMessageT,
  { _tag: Tag }
>;

export const state_Idle = ProtocolState.make("Idle", "Client");
export const state_Acquiring = ProtocolState.make("Acquiring", "Server");
export const state_Acquired = ProtocolState.make("Acquired", "Client");
export const state_Querying = ProtocolState.make("Querying", "Server");
export const state_Done = ProtocolState.make("Done", "Neither");

export const tAcquire: Transition<
  typeof state_Idle,
  Narrow<LocalStateQueryMessageType.Acquire>,
  typeof state_Acquiring
> = {
  from: state_Idle,
  to: state_Acquiring,
  message: filteredCodec(LocalStateQueryMessageBytes, LocalStateQueryMessageType.Acquire),
};

export const tAcquired: Transition<
  typeof state_Acquiring,
  Narrow<LocalStateQueryMessageType.Acquired>,
  typeof state_Acquired
> = {
  from: state_Acquiring,
  to: state_Acquired,
  message: filteredCodec(LocalStateQueryMessageBytes, LocalStateQueryMessageType.Acquired),
};

export const tFailure: Transition<
  typeof state_Acquiring,
  Narrow<LocalStateQueryMessageType.Failure>,
  typeof state_Idle
> = {
  from: state_Acquiring,
  to: state_Idle,
  message: filteredCodec(LocalStateQueryMessageBytes, LocalStateQueryMessageType.Failure),
};

export const tQuery: Transition<
  typeof state_Acquired,
  Narrow<LocalStateQueryMessageType.Query>,
  typeof state_Querying
> = {
  from: state_Acquired,
  to: state_Querying,
  message: filteredCodec(LocalStateQueryMessageBytes, LocalStateQueryMessageType.Query),
};

export const tResult: Transition<
  typeof state_Querying,
  Narrow<LocalStateQueryMessageType.Result>,
  typeof state_Acquired
> = {
  from: state_Querying,
  to: state_Acquired,
  message: filteredCodec(LocalStateQueryMessageBytes, LocalStateQueryMessageType.Result),
};

export const tReAcquire: Transition<
  typeof state_Acquired,
  Narrow<LocalStateQueryMessageType.ReAcquire>,
  typeof state_Acquiring
> = {
  from: state_Acquired,
  to: state_Acquiring,
  message: filteredCodec(LocalStateQueryMessageBytes, LocalStateQueryMessageType.ReAcquire),
};

export const tRelease: Transition<
  typeof state_Acquired,
  Narrow<LocalStateQueryMessageType.Release>,
  typeof state_Idle
> = {
  from: state_Acquired,
  to: state_Idle,
  message: filteredCodec(LocalStateQueryMessageBytes, LocalStateQueryMessageType.Release),
};

export const tDone: Transition<
  typeof state_Idle,
  Narrow<LocalStateQueryMessageType.Done>,
  typeof state_Done
> = {
  from: state_Idle,
  to: state_Done,
  message: filteredCodec(LocalStateQueryMessageBytes, LocalStateQueryMessageType.Done),
};

export const localStateQueryTransitions = [
  tAcquire,
  tAcquired,
  tFailure,
  tQuery,
  tResult,
  tReAcquire,
  tRelease,
  tDone,
] as const;
