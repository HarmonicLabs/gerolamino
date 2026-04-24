/**
 * PeerSharing agency table — Ouroboros network-spec §4.5 (Conway+).
 *
 *        Client has agency                Server has agency
 *        ─────────────────                ─────────────────
 *
 *              Idle  ──MsgShareRequest──►  Busy
 *              Idle  ◄────MsgSharePeers──  Busy
 *              Done  ──MsgDone──►  Done
 *
 * The response-cap invariant (`SharePeers.peers.length ≤ ShareRequest.amount`)
 * is enforced in the client layer — see `Client.ts` for the
 * `OversizedPeerShareResponse` error + `oversizedPeerSharingResponse`
 * metric (wave-2 research correction #28 — NOT silent truncate).
 */
import { ProtocolState, filteredCodec } from "../../typed-channel";
import type { Transition } from "../../typed-channel";
import { PeerSharingMessageBytes, PeerSharingMessageType } from "./Schemas";
import type { PeerSharingMessageT } from "./Schemas";

type Narrow<Tag extends PeerSharingMessageType> = Extract<PeerSharingMessageT, { _tag: Tag }>;

export const state_Idle = ProtocolState.make("Idle", "Client");
export const state_Busy = ProtocolState.make("Busy", "Server");
export const state_Done = ProtocolState.make("Done", "Neither");

export const tShareRequest: Transition<
  typeof state_Idle,
  Narrow<PeerSharingMessageType.ShareRequest>,
  typeof state_Busy
> = {
  from: state_Idle,
  to: state_Busy,
  message: filteredCodec(PeerSharingMessageBytes, PeerSharingMessageType.ShareRequest),
};

export const tSharePeers: Transition<
  typeof state_Busy,
  Narrow<PeerSharingMessageType.SharePeers>,
  typeof state_Idle
> = {
  from: state_Busy,
  to: state_Idle,
  message: filteredCodec(PeerSharingMessageBytes, PeerSharingMessageType.SharePeers),
};

export const tDone: Transition<
  typeof state_Idle,
  Narrow<PeerSharingMessageType.Done>,
  typeof state_Done
> = {
  from: state_Idle,
  to: state_Done,
  message: filteredCodec(PeerSharingMessageBytes, PeerSharingMessageType.Done),
};

export const peerSharingTransitions = [tShareRequest, tSharePeers, tDone] as const;
