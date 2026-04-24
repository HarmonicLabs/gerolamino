/**
 * LocalTxSubmit agency table — Ouroboros network-spec §5.
 *
 *        Client has agency                Server has agency
 *        ─────────────────                ─────────────────
 *
 *              Idle  ──MsgSubmitTx──►  Busy
 *              Idle  ◄──MsgAcceptTx──  Busy
 *              Idle  ◄──MsgRejectTx──  Busy
 *              Done  ──MsgDone──►  Done
 *              Done  (Neither — terminal)
 */
import { ProtocolState, filteredCodec } from "../../typed-channel";
import type { Transition } from "../../typed-channel";
import { LocalTxSubmitMessageBytes, LocalTxSubmitMessageType } from "./Schemas";
import type { LocalTxSubmitMessageT } from "./Schemas";

type Narrow<Tag extends LocalTxSubmitMessageType> = Extract<
  LocalTxSubmitMessageT,
  { _tag: Tag }
>;

export const state_Idle = ProtocolState.make("Idle", "Client");
export const state_Busy = ProtocolState.make("Busy", "Server");
export const state_Done = ProtocolState.make("Done", "Neither");

export const tSubmitTx: Transition<
  typeof state_Idle,
  Narrow<LocalTxSubmitMessageType.SubmitTx>,
  typeof state_Busy
> = {
  from: state_Idle,
  to: state_Busy,
  message: filteredCodec(LocalTxSubmitMessageBytes, LocalTxSubmitMessageType.SubmitTx),
};

export const tAcceptTx: Transition<
  typeof state_Busy,
  Narrow<LocalTxSubmitMessageType.AcceptTx>,
  typeof state_Idle
> = {
  from: state_Busy,
  to: state_Idle,
  message: filteredCodec(LocalTxSubmitMessageBytes, LocalTxSubmitMessageType.AcceptTx),
};

export const tRejectTx: Transition<
  typeof state_Busy,
  Narrow<LocalTxSubmitMessageType.RejectTx>,
  typeof state_Idle
> = {
  from: state_Busy,
  to: state_Idle,
  message: filteredCodec(LocalTxSubmitMessageBytes, LocalTxSubmitMessageType.RejectTx),
};

export const tDone: Transition<
  typeof state_Idle,
  Narrow<LocalTxSubmitMessageType.Done>,
  typeof state_Done
> = {
  from: state_Idle,
  to: state_Done,
  message: filteredCodec(LocalTxSubmitMessageBytes, LocalTxSubmitMessageType.Done),
};

export const localTxSubmitTransitions = [tSubmitTx, tAcceptTx, tRejectTx, tDone] as const;
