/**
 * Peer manager — tracks upstream Cardano relay peers and their chain tips.
 *
 * Follows Dingo's multi-tier peer governance pattern:
 *   - Per-peer state: connection status, current tip, last activity
 *   - Stall detection: mark peers inactive after timeout
 *   - Best peer selection: Praos chain comparison across all peers
 *
 * For a data node, we only need N2N ChainSync clients (no block production).
 *
 * Uses Effect abstractions throughout:
 *   - Clock.currentTimeMillis for testable timestamps
 *   - Ref<Map> for atomic peer state
 *   - Config for tunable timeouts
 */
import { Clock, Config, Duration, Effect, Ref, Schema, ServiceMap } from "effect";
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

/** Stall timeout — configurable via PEER_STALL_TIMEOUT_MS, defaults to 120000 (2 min). */
const StallTimeoutMs = Config.int("PEER_STALL_TIMEOUT_MS").pipe(
  Config.withDefault(2 * 60 * 1000),
);

/** Recycle cooldown — configurable via PEER_RECYCLE_COOLDOWN_MS, defaults to 240000 (4 min). */
const RecycleCooldownMs = Config.int("PEER_RECYCLE_COOLDOWN_MS").pipe(
  Config.withDefault(4 * 60 * 1000),
);

export class PeerManager extends ServiceMap.Service<
  PeerManager,
  {
    /** Register a new peer connection. */
    readonly addPeer: (peerId: string, address?: string) => Effect.Effect<void, PeerManagerError>;
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
  const stallTimeoutMs = yield* StallTimeoutMs;
  const peers = yield* Ref.make(new Map<string, PeerState>());

  return {
    addPeer: (peerId: string, address?: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.update(peers, (m) => {
            const next = new Map(m);
            next.set(peerId, {
              peerId,
              address: address ?? peerId,
              status: "connecting",
              tip: undefined,
              lastActivityMs: Number(now),
              headersReceived: 0,
            });
            return next;
          }),
        ),
      ),

    updatePeerTip: (peerId: string, tip: ChainTip) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.update(peers, (m) => {
            const peer = m.get(peerId);
            if (!peer) return m;
            const next = new Map(m);
            next.set(peerId, {
              ...peer,
              tip,
              status: "syncing",
              lastActivityMs: Number(now),
              headersReceived: peer.headersReceived + 1,
            });
            return next;
          }),
        ),
      ),

    removePeer: (peerId: string) =>
      Ref.update(peers, (m) => {
        const peer = m.get(peerId);
        if (!peer) return m;
        const next = new Map(m);
        next.set(peerId, { ...peer, status: "disconnected" });
        return next;
      }),

    getBestPeer: Ref.get(peers).pipe(
      Effect.map((m) => {
        let best: PeerState | undefined;
        for (const peer of m.values()) {
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
    ),

    getPeers: Ref.get(peers).pipe(Effect.map((m) => [...m.values()])),

    detectStalls: Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Ref.modify(peers, (m) => {
          const stalled: string[] = [];
          const next = new Map(m);
          for (const [id, peer] of next) {
            if (peer.status === "disconnected" || peer.status === "stalled") continue;
            if (Number(now) - peer.lastActivityMs > stallTimeoutMs) {
              next.set(id, { ...peer, status: "stalled" });
              stalled.push(id);
            }
          }
          return [stalled, next];
        }),
      ),
    ),

    getStatusCounts: Ref.get(peers).pipe(
      Effect.map((m) => {
        const counts: Record<PeerStatus, number> = {
          connecting: 0,
          syncing: 0,
          synced: 0,
          stalled: 0,
          disconnected: 0,
        };
        for (const peer of m.values()) {
          counts[peer.status]++;
        }
        return counts;
      }),
    ),
  };
});
