/**
 * TxSubmission2 agency table — Ouroboros network-spec §4.8.
 *
 *        Client has agency                Server has agency
 *        ─────────────────                ─────────────────
 *
 *              Init  ──MsgInit──►  Idle
 *              TxIds ◄─MsgRequestTxIds──  Idle
 *              Idle  ◄─MsgReplyTxIds───   TxIds
 *              Txs   ◄─MsgRequestTxs──    Idle
 *              Idle  ◄─MsgReplyTxs─────   Txs
 *              Done  ◄─MsgDone──          Idle
 *              Done  (Neither — terminal)
 *
 * Ack-window invariant (wave-2 correction confirmed; plan Tier-1 §2d):
 * the client may have at most 10 outstanding `TxId`s unacknowledged at
 * any time. Enforced in the client layer (`Client.ts`) — a violating peer
 * is disconnected + counted via `Metric.counter("peer.txsub.ack_window_violation")`.
 */
import { ProtocolState, filteredCodec } from "../../typed-channel";
import type { Transition } from "../../typed-channel";
import { TxSubmissionMessageBytes, TxSubmissionMessageType } from "./Schemas";
import type { TxSubmissionMessageT } from "./Schemas";

type Narrow<Tag extends TxSubmissionMessageType> = Extract<TxSubmissionMessageT, { _tag: Tag }>;

export const state_Init = ProtocolState.make("Init", "Client");
export const state_Idle = ProtocolState.make("Idle", "Server");
export const state_TxIds = ProtocolState.make("TxIds", "Client");
export const state_Txs = ProtocolState.make("Txs", "Client");
export const state_Done = ProtocolState.make("Done", "Neither");

export const tInit: Transition<
  typeof state_Init,
  Narrow<TxSubmissionMessageType.Init>,
  typeof state_Idle
> = {
  from: state_Init,
  to: state_Idle,
  message: filteredCodec(TxSubmissionMessageBytes, TxSubmissionMessageType.Init),
};

export const tRequestTxIds: Transition<
  typeof state_Idle,
  Narrow<TxSubmissionMessageType.RequestTxIds>,
  typeof state_TxIds
> = {
  from: state_Idle,
  to: state_TxIds,
  message: filteredCodec(TxSubmissionMessageBytes, TxSubmissionMessageType.RequestTxIds),
};

export const tReplyTxIds: Transition<
  typeof state_TxIds,
  Narrow<TxSubmissionMessageType.ReplyTxIds>,
  typeof state_Idle
> = {
  from: state_TxIds,
  to: state_Idle,
  message: filteredCodec(TxSubmissionMessageBytes, TxSubmissionMessageType.ReplyTxIds),
};

export const tRequestTxs: Transition<
  typeof state_Idle,
  Narrow<TxSubmissionMessageType.RequestTxs>,
  typeof state_Txs
> = {
  from: state_Idle,
  to: state_Txs,
  message: filteredCodec(TxSubmissionMessageBytes, TxSubmissionMessageType.RequestTxs),
};

export const tReplyTxs: Transition<
  typeof state_Txs,
  Narrow<TxSubmissionMessageType.ReplyTxs>,
  typeof state_Idle
> = {
  from: state_Txs,
  to: state_Idle,
  message: filteredCodec(TxSubmissionMessageBytes, TxSubmissionMessageType.ReplyTxs),
};

export const tDone: Transition<
  typeof state_Idle,
  Narrow<TxSubmissionMessageType.Done>,
  typeof state_Done
> = {
  from: state_Idle,
  to: state_Done,
  message: filteredCodec(TxSubmissionMessageBytes, TxSubmissionMessageType.Done),
};

export const txSubmissionTransitions = [
  tInit,
  tRequestTxIds,
  tReplyTxIds,
  tRequestTxs,
  tReplyTxs,
  tDone,
] as const;

/** Maximum outstanding unacknowledged TxIds per peer (Haskell parity). */
export const TX_SUBMISSION_ACK_WINDOW = 10;
