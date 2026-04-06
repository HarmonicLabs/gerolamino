/**
 * Peer manager — tracks upstream Cardano relay peers and their chain tips.
 *
 * Follows Dingo's multi-tier peer governance pattern:
 *   - Per-peer state: connection status, current tip, last activity
 *   - Stall detection: mark peers inactive after timeout
 *   - Best peer selection: Praos chain comparison across all peers
 *
 * For a data node, we only need N2N ChainSync clients (no block production).
 */
import { Effect, Schema, ServiceMap, Stream } from "effect";
import { SlotClock } from "./clock";
import { ChainTip, preferCandidate } from "./chain-selection";

export class PeerManagerError extends Schema.TaggedErrorClass<PeerManagerError>()(
  "PeerManagerError",
  { message: Schema.String, cause: Schema.Defect },
) {}

/** Connection status for a tracked peer. */
export type PeerStatus = "connecting" | "syncing" | "synced" | "stalled" | "disconnected";

/** Per-peer tracked state. */
export interface PeerState {
  readonly peerId: string;
  readonly address: string;
  readonly status: PeerStatus;
  readonly tip: ChainTip | undefined;
  readonly lastActivityMs: number;
  readonly headersReceived: number;
}

/** Default stall timeout: 2 minutes (per Dingo). */
const STALL_TIMEOUT_MS = 2 * 60 * 1000;

/** Minimum time between connection recycles (per Dingo). */
const RECYCLE_COOLDOWN_MS = 4 * 60 * 1000;

export class PeerManager extends ServiceMap.Service<
  PeerManager,
  {
    /** Register a new peer connection. */
    readonly addPeer: (peerId: string, address: string) => Effect.Effect<void, PeerManagerError>;
    /** Update a peer's tip after receiving a header. */
    readonly updatePeerTip: (peerId: string, tip: ChainTip) => Effect.Effect<void, PeerManagerError>;
    /** Mark a peer as disconnected. */
    readonly removePeer: (peerId: string) => Effect.Effect<void, PeerManagerError>;
    /** Get the current best peer (highest tip by Praos rules). */
    readonly getBestPeer: Effect.Effect<PeerState | undefined, PeerManagerError>;
    /** Get all tracked peers. */
    readonly getPeers: Effect.Effect<ReadonlyArray<PeerState>, PeerManagerError>;
    /** Check for stalled peers and mark them. */
    readonly detectStalls: Effect.Effect<ReadonlyArray<string>, PeerManagerError>;
    /** Get peer count by status. */
    readonly getStatusCounts: Effect.Effect<Record<PeerStatus, number>, PeerManagerError>;
  }
>()("consensus/PeerManager") {}

/** In-memory peer manager implementation. */
export const PeerManagerLive = Effect.gen(function* () {
  const slotClock = yield* SlotClock;
  const peers = new Map<string, PeerState>();
  let lastRecycleMs = 0;

  return {
    addPeer: (peerId: string, address: string) =>
      Effect.sync(() => {
        peers.set(peerId, {
          peerId,
          address,
          status: "connecting",
          tip: undefined,
          lastActivityMs: Date.now(),
          headersReceived: 0,
        });
      }),

    updatePeerTip: (peerId: string, tip: ChainTip) =>
      Effect.sync(() => {
        const peer = peers.get(peerId);
        if (!peer) return;
        peers.set(peerId, {
          ...peer,
          tip,
          status: "syncing",
          lastActivityMs: Date.now(),
          headersReceived: peer.headersReceived + 1,
        });
      }),

    removePeer: (peerId: string) =>
      Effect.sync(() => {
        const peer = peers.get(peerId);
        if (peer) {
          peers.set(peerId, { ...peer, status: "disconnected" });
        }
      }),

    getBestPeer: Effect.sync(() => {
      let best: PeerState | undefined;
      for (const peer of peers.values()) {
        if (peer.status === "disconnected" || peer.status === "stalled") continue;
        if (!peer.tip) continue;
        if (!best || !best.tip) {
          best = peer;
          continue;
        }
        if (preferCandidate(best.tip, peer.tip, 0, slotClock.config.securityParam)) {
          best = peer;
        }
      }
      return best;
    }),

    getPeers: Effect.sync(() => [...peers.values()]),

    detectStalls: Effect.sync(() => {
      const now = Date.now();
      const stalled: string[] = [];
      for (const [id, peer] of peers) {
        if (peer.status === "disconnected" || peer.status === "stalled") continue;
        if (now - peer.lastActivityMs > STALL_TIMEOUT_MS) {
          peers.set(id, { ...peer, status: "stalled" });
          stalled.push(id);
        }
      }
      return stalled;
    }),

    getStatusCounts: Effect.sync(() => {
      const counts: Record<PeerStatus, number> = {
        connecting: 0,
        syncing: 0,
        synced: 0,
        stalled: 0,
        disconnected: 0,
      };
      for (const peer of peers.values()) {
        counts[peer.status]++;
      }
      return counts;
    }),
  };
});
