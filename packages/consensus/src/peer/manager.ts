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
 *   - Ref<Map> for atomic peer state (reads-after-write via Ref.modify)
 *   - Config for tunable timeouts
 */
import { Clock, Config, Context, Effect, Layer, Metric, Option, Ref, Schema } from "effect";
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
 *  every add / remove. */
const activePeerCount = (m: ReadonlyMap<string, PeerState>): number =>
  [...m.values()].filter(isConnected).length;

/** Zero-seed for `getStatusCounts` derived directly from the Schema
 *  literal list so adding a new status constant can't leave a gap. */
const PEER_STATUS_ZERO_SEED: Record<PeerStatus, number> = Object.fromEntries(
  PeerStatus.literals.map((s) => [s, 0]),
) as Record<PeerStatus, number>;

/** Immutable `m.set(key, updater(existing))` — returns a new Map if the
 *  key exists, otherwise `undefined` so callers can short-circuit. */
const mapUpdate = <K, V>(m: ReadonlyMap<K, V>, key: K, f: (value: V) => V): Map<K, V> | undefined => {
  const existing = m.get(key);
  if (existing === undefined) return undefined;
  const next = new Map(m);
  next.set(key, f(existing));
  return next;
};

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
  const peers = yield* Ref.make<Map<string, PeerState>>(new Map());

  /** Atomic "replace entry + publish PeerCount" — used by add + remove.
   *  `Ref.modify` returns the new active count from the same read, so the
   *  metric update doesn't need a second `Ref.get`. */
  const modifyAndPublishCount = (f: (m: Map<string, PeerState>) => Map<string, PeerState>) =>
    Ref.modify(peers, (m) => {
      const next = f(m);
      return [activePeerCount(next), next] as const;
    }).pipe(Effect.flatMap((count) => Metric.update(PeerCount, count)));

  return {
    addPeer: (peerId: string, address?: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          modifyAndPublishCount((m) => {
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
        Effect.withSpan(SPAN.PeerConnect, { attributes: { "peer.id": peerId } }),
      ),

    updatePeerTip: (peerId: string, tip: ChainTip) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.update(peers, (m) =>
            mapUpdate(m, peerId, (peer) => ({
              ...peer,
              tip,
              status: "syncing",
              lastActivityMs: Number(now),
              headersReceived: peer.headersReceived + 1,
            })) ?? m,
          ),
        ),
      ),

    removePeer: (peerId: string) =>
      modifyAndPublishCount(
        (m) =>
          mapUpdate(m, peerId, (peer) => ({ ...peer, status: "disconnected" })) ?? new Map(m),
      ).pipe(Effect.withSpan(SPAN.PeerDisconnect, { attributes: { "peer.id": peerId } })),

    getBestPeer: Ref.get(peers).pipe(
      Effect.map((m) => {
        // Narrow to peers that (a) have a tip and (b) are eligible for
        // selection. `isActiveWithTip` is a type guard so `peer.tip` reads
        // directly inside the reduce — no `!` assertion needed.
        const active = [...m.values()].filter(isActiveWithTip);
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

    getPeers: Ref.get(peers).pipe(Effect.map((m) => [...m.values()])),

    detectStalls: Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => {
        const nowMs = Number(now);
        return Ref.modify(peers, (m) => {
          // Walk entries once; accumulate the stalled id list + new Map
          // with status flipped. The for-of is a byte-assembly-adjacent
          // site (dual accumulator: list + keyed map), so mutation is
          // local and commented. No external state escapes.
          const stalled: string[] = [];
          const next = new Map(m);
          for (const [id, peer] of m) {
            if (!isEligibleForStall(peer)) continue;
            if (nowMs - peer.lastActivityMs > stallTimeoutMs) {
              next.set(id, { ...peer, status: "stalled" });
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
        ...countBy([...m.values()], (p) => p.status),
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
