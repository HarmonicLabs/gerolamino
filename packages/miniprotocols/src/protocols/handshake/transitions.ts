/**
 * Handshake agency table — Ouroboros network-spec §4.2.
 *
 *        Client has agency                Server has agency
 *        ─────────────────                ─────────────────
 *
 *           Propose  ──MsgProposeVersions──►  Confirm
 *             Done   ◄──MsgAcceptVersion───   Confirm
 *             Done   ◄────MsgRefuse────────   Confirm
 *             Done   ◄──MsgQueryReply──────   Confirm  (N2C-only)
 *             Done   (Neither — terminal)
 *
 * Consumed by Bun/browser/mock entry points that want compile-time agency
 * enforcement (see `typed-channel/`). The existing `HandshakeClient` still
 * uses the multiplexer PubSub shape for backward compatibility; new call
 * sites opting into `TypedChannel` get the stricter checking.
 */
import { ProtocolState, filteredCodec } from "../../typed-channel";
import type { Transition } from "../../typed-channel";
import { HandshakeMessageBytes, HandshakeMessageType } from "./Schemas";
import type { HandshakeMessageT } from "./Schemas";

type Narrow<Tag extends HandshakeMessageType> = Extract<HandshakeMessageT, { _tag: Tag }>;

export const state_Propose = ProtocolState.make("Propose", "Client");
export const state_Confirm = ProtocolState.make("Confirm", "Server");
export const state_Done = ProtocolState.make("Done", "Neither");

export const tProposeVersions: Transition<
  typeof state_Propose,
  Narrow<HandshakeMessageType.MsgProposeVersions>,
  typeof state_Confirm
> = {
  from: state_Propose,
  to: state_Confirm,
  message: filteredCodec(HandshakeMessageBytes, HandshakeMessageType.MsgProposeVersions),
};

export const tAcceptVersion: Transition<
  typeof state_Confirm,
  Narrow<HandshakeMessageType.MsgAcceptVersion>,
  typeof state_Done
> = {
  from: state_Confirm,
  to: state_Done,
  message: filteredCodec(HandshakeMessageBytes, HandshakeMessageType.MsgAcceptVersion),
};

export const tRefuse: Transition<
  typeof state_Confirm,
  Narrow<HandshakeMessageType.MsgRefuse>,
  typeof state_Done
> = {
  from: state_Confirm,
  to: state_Done,
  message: filteredCodec(HandshakeMessageBytes, HandshakeMessageType.MsgRefuse),
};

export const tQueryReply: Transition<
  typeof state_Confirm,
  Narrow<HandshakeMessageType.MsgQueryReply>,
  typeof state_Done
> = {
  from: state_Confirm,
  to: state_Done,
  message: filteredCodec(HandshakeMessageBytes, HandshakeMessageType.MsgQueryReply),
};

export const handshakeTransitions = [
  tProposeVersions,
  tAcceptVersion,
  tRefuse,
  tQueryReply,
] as const;
