/**
 * LocalChainSync agency table — Ouroboros network-spec §5.
 *
 * Identical FSM to N2N ChainSync but the wire codecs come from
 * `LocalChainSyncMessageBytes` (N2C message set). Consumers that want
 * compile-time agency enforcement for local chain-sync bind against
 * `localChainSyncTransitions`; upstream `ChainSyncClient` remains on
 * the multiplexer PubSub shape for backward compatibility.
 */
import { ProtocolState, filteredCodec } from "../../typed-channel";
import type { Transition } from "../../typed-channel";
import { LocalChainSyncMessageBytes, LocalChainSyncMessageType } from "./Schemas";
import type { LocalChainSyncMessageT } from "./Schemas";

type Narrow<Tag extends LocalChainSyncMessageType> = Extract<LocalChainSyncMessageT, { _tag: Tag }>;

export const state_Idle = ProtocolState.make("Idle", "Client");
export const state_CanAwait = ProtocolState.make("CanAwait", "Server");
export const state_MustReply = ProtocolState.make("MustReply", "Server");
export const state_Intersect = ProtocolState.make("Intersect", "Server");
export const state_Done = ProtocolState.make("Done", "Neither");

export const tRequestNext: Transition<
  typeof state_Idle,
  Narrow<LocalChainSyncMessageType.RequestNext>,
  typeof state_CanAwait
> = {
  from: state_Idle,
  to: state_CanAwait,
  message: filteredCodec(LocalChainSyncMessageBytes, LocalChainSyncMessageType.RequestNext),
};

export const tRollForwardFromCanAwait: Transition<
  typeof state_CanAwait,
  Narrow<LocalChainSyncMessageType.RollForward>,
  typeof state_Idle
> = {
  from: state_CanAwait,
  to: state_Idle,
  message: filteredCodec(LocalChainSyncMessageBytes, LocalChainSyncMessageType.RollForward),
};

export const tRollBackwardFromCanAwait: Transition<
  typeof state_CanAwait,
  Narrow<LocalChainSyncMessageType.RollBackward>,
  typeof state_Idle
> = {
  from: state_CanAwait,
  to: state_Idle,
  message: filteredCodec(LocalChainSyncMessageBytes, LocalChainSyncMessageType.RollBackward),
};

export const tAwaitReply: Transition<
  typeof state_CanAwait,
  Narrow<LocalChainSyncMessageType.AwaitReply>,
  typeof state_MustReply
> = {
  from: state_CanAwait,
  to: state_MustReply,
  message: filteredCodec(LocalChainSyncMessageBytes, LocalChainSyncMessageType.AwaitReply),
};

export const tRollForwardFromMustReply: Transition<
  typeof state_MustReply,
  Narrow<LocalChainSyncMessageType.RollForward>,
  typeof state_Idle
> = {
  from: state_MustReply,
  to: state_Idle,
  message: filteredCodec(LocalChainSyncMessageBytes, LocalChainSyncMessageType.RollForward),
};

export const tRollBackwardFromMustReply: Transition<
  typeof state_MustReply,
  Narrow<LocalChainSyncMessageType.RollBackward>,
  typeof state_Idle
> = {
  from: state_MustReply,
  to: state_Idle,
  message: filteredCodec(LocalChainSyncMessageBytes, LocalChainSyncMessageType.RollBackward),
};

export const tFindIntersect: Transition<
  typeof state_Idle,
  Narrow<LocalChainSyncMessageType.FindIntersect>,
  typeof state_Intersect
> = {
  from: state_Idle,
  to: state_Intersect,
  message: filteredCodec(LocalChainSyncMessageBytes, LocalChainSyncMessageType.FindIntersect),
};

export const tIntersectFound: Transition<
  typeof state_Intersect,
  Narrow<LocalChainSyncMessageType.IntersectFound>,
  typeof state_Idle
> = {
  from: state_Intersect,
  to: state_Idle,
  message: filteredCodec(LocalChainSyncMessageBytes, LocalChainSyncMessageType.IntersectFound),
};

export const tIntersectNotFound: Transition<
  typeof state_Intersect,
  Narrow<LocalChainSyncMessageType.IntersectNotFound>,
  typeof state_Idle
> = {
  from: state_Intersect,
  to: state_Idle,
  message: filteredCodec(LocalChainSyncMessageBytes, LocalChainSyncMessageType.IntersectNotFound),
};

export const tDone: Transition<
  typeof state_Idle,
  Narrow<LocalChainSyncMessageType.Done>,
  typeof state_Done
> = {
  from: state_Idle,
  to: state_Done,
  message: filteredCodec(LocalChainSyncMessageBytes, LocalChainSyncMessageType.Done),
};

export const localChainSyncTransitions = [
  tRequestNext,
  tRollForwardFromCanAwait,
  tRollBackwardFromCanAwait,
  tAwaitReply,
  tRollForwardFromMustReply,
  tRollBackwardFromMustReply,
  tFindIntersect,
  tIntersectFound,
  tIntersectNotFound,
  tDone,
] as const;
