/**
 * ChainSync agency table — Ouroboros network-spec §4.6.
 *
 *        Client has agency                Server has agency
 *        ─────────────────                ─────────────────
 *
 *              Idle  ──MsgRequestNext──►  CanAwait
 *              Idle  ◄─MsgRollForward───  CanAwait
 *              Idle  ◄─MsgRollBackward──  CanAwait
 *           MustReply ◄──MsgAwaitReply──  CanAwait
 *              Idle  ◄─MsgRollForward───  MustReply
 *              Idle  ◄─MsgRollBackward──  MustReply
 *              Idle  ──MsgFindIntersect─► Intersect
 *              Idle  ◄─MsgIntersectFound─ Intersect
 *              Idle  ◄─MsgIntersectNotFound─ Intersect
 *              Done  ──MsgDone──► Done
 *              Done  (Neither — terminal)
 *
 * Pipelining (plan Tier-1 §2c + wave-2 correction #25): ChainSync allows
 * `MsgRequestNext` pipelining up to a peer-advertised window — upstream
 * Haskell uses 300 high-mark / 200 low-mark
 * (`cardano-diffusion/lib/Cardano/Network/NodeToNode.hs:210-212`). The
 * typed-channel enforces single-at-a-time send/recv per cursor; high-water
 * pipelining is layered on top by the client (see `Client.ts`) via an
 * `Effect.Semaphore` with refill-at-low-water semantics.
 */
import { ProtocolState, filteredCodec } from "../../typed-channel";
import type { Transition } from "../../typed-channel";
import { ChainSyncMessageBytes, ChainSyncMessageType } from "./Schemas";
import type { ChainSyncMessageT } from "./Schemas";

type Narrow<Tag extends ChainSyncMessageType> = Extract<ChainSyncMessageT, { _tag: Tag }>;

export const state_Idle = ProtocolState.make("Idle", "Client");
export const state_CanAwait = ProtocolState.make("CanAwait", "Server");
export const state_MustReply = ProtocolState.make("MustReply", "Server");
export const state_Intersect = ProtocolState.make("Intersect", "Server");
export const state_Done = ProtocolState.make("Done", "Neither");

export const tRequestNext: Transition<
  typeof state_Idle,
  Narrow<ChainSyncMessageType.RequestNext>,
  typeof state_CanAwait
> = {
  from: state_Idle,
  to: state_CanAwait,
  message: filteredCodec(ChainSyncMessageBytes, ChainSyncMessageType.RequestNext),
};

export const tRollForwardFromCanAwait: Transition<
  typeof state_CanAwait,
  Narrow<ChainSyncMessageType.RollForward>,
  typeof state_Idle
> = {
  from: state_CanAwait,
  to: state_Idle,
  message: filteredCodec(ChainSyncMessageBytes, ChainSyncMessageType.RollForward),
};

export const tRollBackwardFromCanAwait: Transition<
  typeof state_CanAwait,
  Narrow<ChainSyncMessageType.RollBackward>,
  typeof state_Idle
> = {
  from: state_CanAwait,
  to: state_Idle,
  message: filteredCodec(ChainSyncMessageBytes, ChainSyncMessageType.RollBackward),
};

export const tAwaitReply: Transition<
  typeof state_CanAwait,
  Narrow<ChainSyncMessageType.AwaitReply>,
  typeof state_MustReply
> = {
  from: state_CanAwait,
  to: state_MustReply,
  message: filteredCodec(ChainSyncMessageBytes, ChainSyncMessageType.AwaitReply),
};

export const tRollForwardFromMustReply: Transition<
  typeof state_MustReply,
  Narrow<ChainSyncMessageType.RollForward>,
  typeof state_Idle
> = {
  from: state_MustReply,
  to: state_Idle,
  message: filteredCodec(ChainSyncMessageBytes, ChainSyncMessageType.RollForward),
};

export const tRollBackwardFromMustReply: Transition<
  typeof state_MustReply,
  Narrow<ChainSyncMessageType.RollBackward>,
  typeof state_Idle
> = {
  from: state_MustReply,
  to: state_Idle,
  message: filteredCodec(ChainSyncMessageBytes, ChainSyncMessageType.RollBackward),
};

export const tFindIntersect: Transition<
  typeof state_Idle,
  Narrow<ChainSyncMessageType.FindIntersect>,
  typeof state_Intersect
> = {
  from: state_Idle,
  to: state_Intersect,
  message: filteredCodec(ChainSyncMessageBytes, ChainSyncMessageType.FindIntersect),
};

export const tIntersectFound: Transition<
  typeof state_Intersect,
  Narrow<ChainSyncMessageType.IntersectFound>,
  typeof state_Idle
> = {
  from: state_Intersect,
  to: state_Idle,
  message: filteredCodec(ChainSyncMessageBytes, ChainSyncMessageType.IntersectFound),
};

export const tIntersectNotFound: Transition<
  typeof state_Intersect,
  Narrow<ChainSyncMessageType.IntersectNotFound>,
  typeof state_Idle
> = {
  from: state_Intersect,
  to: state_Idle,
  message: filteredCodec(ChainSyncMessageBytes, ChainSyncMessageType.IntersectNotFound),
};

export const tDone: Transition<
  typeof state_Idle,
  Narrow<ChainSyncMessageType.Done>,
  typeof state_Done
> = {
  from: state_Idle,
  to: state_Done,
  message: filteredCodec(ChainSyncMessageBytes, ChainSyncMessageType.Done),
};

export const chainSyncTransitions = [
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
