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
 *   - Ref<HashMap> for atomic peer state — Effect's `HashMap` is a persistent
 *     hash-array-mapped trie, so `set` / `modify` share spine nodes with the
 *     prior version (no full O(n) Map clone per header). The `updatePeerTip`
 *     hot path costs O(log n) instead of O(n).
 *   - Config for tunable timeouts
 */
import {
  Clock,
  Config,
  Context,
  Effect,
  HashMap,
  Layer,
  Metric,
  Option,
  Ref,
  Schema,
} from "effect";
import { countBy } from "es-toolkit";
import { SlotClock } from "../praos/clock";
import { ChainTip, preferCandidate } from "../chain/selection";
import { PeerCount, PeerStalledCount, SPAN } from "../observability.ts";

/** Connection status for a tracked peer. */
export const PeerStatus = Schema.Literals([
  "connecting",
  "syncing",
  "synced",
  "stalled",
  "disconnected",
]);
export type PeerStatus = typeof PeerStatus.Type;

/** Per-peer tracked state. */
export const PeerState = Schema.Struct({
  peerId: Schema.String,
  address: Schema.String,
  status: PeerStatus,
  tip: Schema.optional(ChainTip),
  lastActivityMs: Schema.Number,
  headersReceived: Schema.Number,
});
export type PeerState = typeof PeerState.Type;

/** Stall timeout — configurable via PEER_STALL_TIMEOUT_MS, defaults to 120000 (2 min). */
const StallTimeoutMs = Config.number("PEER_STALL_TIMEOUT_MS").pipe(
  Config.withDefault(2 * 60 * 1000),
);

// ───────────────────────────────────────────────────────────────────────
// Pure helpers — narrowed predicates + small map summaries. Pulled out
// so the service methods read as declarative data shuffles, not
// imperative bookkeeping.
// ───────────────────────────────────────────────────────────────────────

/** Subset of `PeerState` where `tip` is known — used by `getBestPeer` so
 *  the reduce inside can dereference `peer.tip` without `!` assertions. */
type PeerWithTip = PeerState & { readonly tip: ChainTip };

const isConnected = (p: PeerState): boolean => p.status !== "disconnected";
const isEligibleForStall = (p: PeerState): boolean =>
  p.status !== "disconnected" && p.status !== "stalled";
const isActiveWithTip = (p: PeerState): p is PeerWithTip =>
  p.tip !== undefined && p.status !== "disconnected" && p.status !== "stalled";

/** Count of peers not yet disconnected — published to `PeerCount` after
 *  every add / remove. `HashMap.reduce` walks the spine in-place so the
 *  count stays O(n) without materializing an intermediate array. */
const activePeerCount = (m: HashMap.HashMap<string, PeerState>): number =>
  HashMap.reduce(m, 0, (acc, peer) => acc + (isConnected(peer) ? 1 : 0));

/** Zero-seed for `getStatusCounts` derived directly from the Schema
 *  literal list so adding a new status constant can't leave a gap. */
const PEER_STATUS_ZERO_SEED: Record<PeerStatus, number> = Object.fromEntries(
  PeerStatus.literals.map((s) => [s, 0]),
) as Record<PeerStatus, number>;

export class PeerManager extends Context.Service<
  PeerManager,
  {
    /** Register a new peer connection. */
    readonly addPeer: (peerId: string, address?: string) => Effect.Effect<void>;
    /** Update a peer's tip after receiving a header. */
    readonly updatePeerTip: (peerId: string, tip: ChainTip) => Effect.Effect<void>;
    /** Mark a peer as disconnected. */
    readonly removePeer: (peerId: string) => Effect.Effect<void>;
    /** Get the current best peer (highest tip by Praos rules). */
    readonly getBestPeer: Effect.Effect<Option.Option<PeerState>>;
    /** Get all tracked peers. */
    readonly getPeers: Effect.Effect<ReadonlyArray<PeerState>>;
    /** Check for stalled peers and mark them. */
    readonly detectStalls: Effect.Effect<ReadonlyArray<string>>;
    /** Get peer count by status. */
    readonly getStatusCounts: Effect.Effect<Record<PeerStatus, number>>;
  }
>()("consensus/PeerManager") {}

/** In-memory peer manager implementation. */
export const PeerManagerLive = Effect.gen(function* () {
  const slotClock = yield* SlotClock;
  const stallTimeoutMs = yield* StallTimeoutMs;
  const peers = yield* Ref.make(HashMap.empty<string, PeerState>());

  /** Atomic "replace entry + publish PeerCount" — used by add + remove.
   *  `Ref.modify` returns the new active count from the same read, so the
   *  metric update doesn't need a second `Ref.get`. */
  const modifyAndPublishCount = (
    f: (m: HashMap.HashMap<string, PeerState>) => HashMap.HashMap<string, PeerState>,
  ) =>
    Ref.modify(peers, (m) => {
      const next = f(m);
      return [activePeerCount(next), next] as const;
    }).pipe(Effect.flatMap((count) => Metric.update(PeerCount, count)));

  return {
    addPeer: (peerId: string, address?: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          modifyAndPublishCount((m) =>
            HashMap.set(m, peerId, {
              peerId,
              address: address ?? peerId,
              status: "connecting",
              tip: undefined,
              lastActivityMs: Number(now),
              headersReceived: 0,
            }),
          ),
        ),
        Effect.withSpan(SPAN.PeerConnect, { attributes: { "peer.id": peerId } }),
      ),

    updatePeerTip: (peerId: string, tip: ChainTip) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          // `HashMap.modify` is a no-op when the peer isn't tracked, so
          // unregistered tip notifications drop silently — same semantics
          // as the previous `mapUpdate(...) ?? m` guard.
          Ref.update(peers, (m) =>
            HashMap.modify(m, peerId, (peer) => ({
              ...peer,
              tip,
              status: "syncing",
              lastActivityMs: Number(now),
              headersReceived: peer.headersReceived + 1,
            })),
          ),
        ),
      ),

    removePeer: (peerId: string) =>
      modifyAndPublishCount((m) =>
        HashMap.modify(m, peerId, (peer) => ({ ...peer, status: "disconnected" })),
      ).pipe(Effect.withSpan(SPAN.PeerDisconnect, { attributes: { "peer.id": peerId } })),

    getBestPeer: Ref.get(peers).pipe(
      Effect.map((m) => {
        // Narrow to peers that (a) have a tip and (b) are eligible for
        // selection. `isActiveWithTip` is a type guard so `peer.tip` reads
        // directly inside the reduce — no `!` assertion needed.
        const active = [...HashMap.values(m)].filter(isActiveWithTip);
        const best = active.reduce<PeerWithTip | undefined>(
          (acc, peer) =>
            acc === undefined ||
            preferCandidate(acc.tip, peer.tip, 0, slotClock.config.securityParam)
              ? peer
              : acc,
          undefined,
        );
        return Option.fromNullishOr(best);
      }),
    ),

    getPeers: Ref.get(peers).pipe(Effect.map((m) => [...HashMap.values(m)])),

    detectStalls: Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => {
        const nowMs = Number(now);
        return Ref.modify(peers, (m) => {
          // Walk entries once; accumulate the stalled id list + new
          // HashMap with status flipped. Each `HashMap.set` is an O(log n)
          // structural-sharing update, so k stalled peers cost O(k log n)
          // — much cheaper than the prior `new Map(m)` clone-per-stall.
          // The for-of is a dual-accumulator site (list + keyed map);
          // mutation is local, no external state escapes.
          const stalled: string[] = [];
          let next = m;
          for (const [id, peer] of HashMap.entries(m)) {
            if (!isEligibleForStall(peer)) continue;
            if (nowMs - peer.lastActivityMs > stallTimeoutMs) {
              next = HashMap.set(next, id, { ...peer, status: "stalled" });
              stalled.push(id);
            }
          }
          return [stalled as ReadonlyArray<string>, next] as const;
        });
      }),
      Effect.tap((stalled) =>
        stalled.length > 0
          ? Metric.update(PeerStalledCount, stalled.length).pipe(
              Effect.withSpan(SPAN.PeerStalled, {
                attributes: { "peer.stall_count": stalled.length },
              }),
            )
          : Effect.void,
      ),
    ),

    getStatusCounts: Ref.get(peers).pipe(
      // Single O(n) histogram merged with the zero-seed so downstream
      // consumers can read any status without `?? 0` guards.
      Effect.map((m) => ({
        ...PEER_STATUS_ZERO_SEED,
        ...countBy([...HashMap.values(m)], (p) => p.status),
      })),
    ),
  };
});

/**
 * Pre-built `PeerManager` layer. Depends on `SlotClock`, so consumers must
 * supply one of `SlotClockPreprod` / `SlotClockMainnet` /
 * `SlotClockLiveFromEnvOrPreprod` (from `praos/clock.ts`). Extracted as a
 * named export so every app entrypoint + chrome-ext offscreen doesn't
 * re-roll `Layer.effect(PeerManager, PeerManagerLive)` identically.
 */
export const PeerManagerLayer = Layer.effect(PeerManager, PeerManagerLive);
