/**
 * LocalTxMonitor agency table — Ouroboros network-spec §5 (Conway+).
 *
 *        Client has agency                Server has agency
 *        ─────────────────                ─────────────────
 *
 *              Idle  ──MsgAcquire──►  Acquiring
 *              Acquired ◄─MsgAcquired─ Acquiring
 *              Busy  ◄──MsgNextTx──    Acquired (query)
 *              Acquired ◄─MsgReplyNextTx── Busy
 *              Busy  ◄──MsgHasTx──     Acquired
 *              Acquired ◄─MsgReplyHasTx── Busy
 *              Busy  ◄──MsgGetSizes──  Acquired
 *              Acquired ◄─MsgReplyGetSizes── Busy
 *              Idle  ──MsgRelease──►   Acquired
 *              Done  ──MsgDone──►  Done
 *              Done  (Neither — terminal)
 */
import { ProtocolState, filteredCodec } from "../../typed-channel";
import type { Transition } from "../../typed-channel";
import { LocalTxMonitorMessageBytes, LocalTxMonitorMessageType } from "./Schemas";
import type { LocalTxMonitorMessageT } from "./Schemas";

type Narrow<Tag extends LocalTxMonitorMessageType> = Extract<LocalTxMonitorMessageT, { _tag: Tag }>;

export const state_Idle = ProtocolState.make("Idle", "Client");
export const state_Acquiring = ProtocolState.make("Acquiring", "Server");
export const state_Acquired = ProtocolState.make("Acquired", "Client");
export const state_Busy = ProtocolState.make("Busy", "Server");
export const state_Done = ProtocolState.make("Done", "Neither");

export const tAcquire: Transition<
  typeof state_Idle,
  Narrow<LocalTxMonitorMessageType.Acquire>,
  typeof state_Acquiring
> = {
  from: state_Idle,
  to: state_Acquiring,
  message: filteredCodec(LocalTxMonitorMessageBytes, LocalTxMonitorMessageType.Acquire),
};

export const tAcquired: Transition<
  typeof state_Acquiring,
  Narrow<LocalTxMonitorMessageType.Acquired>,
  typeof state_Acquired
> = {
  from: state_Acquiring,
  to: state_Acquired,
  message: filteredCodec(LocalTxMonitorMessageBytes, LocalTxMonitorMessageType.Acquired),
};

export const tNextTx: Transition<
  typeof state_Acquired,
  Narrow<LocalTxMonitorMessageType.NextTx>,
  typeof state_Busy
> = {
  from: state_Acquired,
  to: state_Busy,
  message: filteredCodec(LocalTxMonitorMessageBytes, LocalTxMonitorMessageType.NextTx),
};

export const tReplyNextTx: Transition<
  typeof state_Busy,
  Narrow<LocalTxMonitorMessageType.ReplyNextTx>,
  typeof state_Acquired
> = {
  from: state_Busy,
  to: state_Acquired,
  message: filteredCodec(LocalTxMonitorMessageBytes, LocalTxMonitorMessageType.ReplyNextTx),
};

export const tHasTx: Transition<
  typeof state_Acquired,
  Narrow<LocalTxMonitorMessageType.HasTx>,
  typeof state_Busy
> = {
  from: state_Acquired,
  to: state_Busy,
  message: filteredCodec(LocalTxMonitorMessageBytes, LocalTxMonitorMessageType.HasTx),
};

export const tReplyHasTx: Transition<
  typeof state_Busy,
  Narrow<LocalTxMonitorMessageType.ReplyHasTx>,
  typeof state_Acquired
> = {
  from: state_Busy,
  to: state_Acquired,
  message: filteredCodec(LocalTxMonitorMessageBytes, LocalTxMonitorMessageType.ReplyHasTx),
};

export const tGetSizes: Transition<
  typeof state_Acquired,
  Narrow<LocalTxMonitorMessageType.GetSizes>,
  typeof state_Busy
> = {
  from: state_Acquired,
  to: state_Busy,
  message: filteredCodec(LocalTxMonitorMessageBytes, LocalTxMonitorMessageType.GetSizes),
};

export const tReplyGetSizes: Transition<
  typeof state_Busy,
  Narrow<LocalTxMonitorMessageType.ReplyGetSizes>,
  typeof state_Acquired
> = {
  from: state_Busy,
  to: state_Acquired,
  message: filteredCodec(LocalTxMonitorMessageBytes, LocalTxMonitorMessageType.ReplyGetSizes),
};

export const tRelease: Transition<
  typeof state_Acquired,
  Narrow<LocalTxMonitorMessageType.Release>,
  typeof state_Idle
> = {
  from: state_Acquired,
  to: state_Idle,
  message: filteredCodec(LocalTxMonitorMessageBytes, LocalTxMonitorMessageType.Release),
};

export const tDone: Transition<
  typeof state_Idle,
  Narrow<LocalTxMonitorMessageType.Done>,
  typeof state_Done
> = {
  from: state_Idle,
  to: state_Done,
  message: filteredCodec(LocalTxMonitorMessageBytes, LocalTxMonitorMessageType.Done),
};

export const localTxMonitorTransitions = [
  tAcquire,
  tAcquired,
  tNextTx,
  tReplyNextTx,
  tHasTx,
  tReplyHasTx,
  tGetSizes,
  tReplyGetSizes,
  tRelease,
  tDone,
] as const;
