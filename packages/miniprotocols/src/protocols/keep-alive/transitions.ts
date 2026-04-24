/**
 * KeepAlive agency table — Ouroboros network-spec §4.4.
 *
 *        Client has agency                Server has agency
 *        ─────────────────                ─────────────────
 *
 *           Client  ──MsgKeepAlive──►  Server
 *           Client  ◄─MsgKeepAliveResponse─  Server
 *             Done  (Neither — terminal)
 *           Client  ──MsgDone──►  Done
 *
 * Cookie equality is a protocol invariant enforced in the client layer —
 * the transition table models the wire shape only. See `Client.ts` for
 * the `KeepAliveCookieMissmatch` error raised when a peer replies with
 * the wrong cookie (wave-2 research correction #27).
 */
import { ProtocolState, filteredCodec } from "../../typed-channel";
import type { Transition } from "../../typed-channel";
import { KeepAliveMessageBytes, KeepAliveMessageType } from "./Schemas";
import type { KeepAliveMessageT } from "./Schemas";

type Narrow<Tag extends KeepAliveMessageType> = Extract<KeepAliveMessageT, { _tag: Tag }>;

export const state_Client = ProtocolState.make("Client", "Client");
export const state_Server = ProtocolState.make("Server", "Server");
export const state_Done = ProtocolState.make("Done", "Neither");

export const tKeepAlive: Transition<
  typeof state_Client,
  Narrow<KeepAliveMessageType.KeepAlive>,
  typeof state_Server
> = {
  from: state_Client,
  to: state_Server,
  message: filteredCodec(KeepAliveMessageBytes, KeepAliveMessageType.KeepAlive),
};

export const tKeepAliveResponse: Transition<
  typeof state_Server,
  Narrow<KeepAliveMessageType.KeepAliveResponse>,
  typeof state_Client
> = {
  from: state_Server,
  to: state_Client,
  message: filteredCodec(KeepAliveMessageBytes, KeepAliveMessageType.KeepAliveResponse),
};

export const tDone: Transition<
  typeof state_Client,
  Narrow<KeepAliveMessageType.Done>,
  typeof state_Done
> = {
  from: state_Client,
  to: state_Done,
  message: filteredCodec(KeepAliveMessageBytes, KeepAliveMessageType.Done),
};

export const keepAliveTransitions = [tKeepAlive, tKeepAliveResponse, tDone] as const;
