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

/** Active-status delta for an add / replace — `removePeer` flips a peer
 *  to "disconnected" so `addPeer` is the only path that can flip the
 *  other way (and only when the peerId is fresh). Reads the prior entry
 *  via `HashMap.get` (O(log n)) so the delta is O(1) regardless of map
 *  size.
 *
 *  Replaces the prior `HashMap.reduce` full-walk that ran on every
 *  add/remove — at full relay density (≥ 500 peers) the walk dominated
 *  the addPeer hot path. The active-count is now maintained as a
 *  separate `Ref<number>`; `getStatusCounts` still does the O(n)
 *  histogram (called rarely, on a poll), but the high-frequency
 *  PeerCount metric update reads from the cached counter. */
const activeCountDelta = (
  prev: HashMap.HashMap<string, PeerState>,
  peerId: string,
  nextStatus: PeerStatus,
): -1 | 0 | 1 => {
  const before = HashMap.get(prev, peerId).pipe(
    Option.map((p) => (isConnected(p) ? 1 : 0)),
    Option.getOrElse(() => 0),
  );
  const after = nextStatus === "disconnected" ? 0 : 1;
  return (after - before) as -1 | 0 | 1;
};

/** Zero-seed for `getStatusCounts`. Listing each literal explicitly lets
 *  TypeScript prove exhaustiveness against `Record<PeerStatus, number>` —
 *  adding a new `PeerStatus` literal causes a type error here, replacing
 *  the prior `Object.fromEntries(...) as Record<...>` cast that the
 *  CLAUDE.md "no `as Type`" rule forbids. */
const PEER_STATUS_ZERO_SEED: Record<PeerStatus, number> = {
  connecting: 0,
  syncing: 0,
  synced: 0,
  stalled: 0,
  disconnected: 0,
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
    /** Get the cached active-peer count (peers with status !== "disconnected").
     *  O(1) read of an internal `Ref<number>` maintained atomically by
     *  `addPeer` / `removePeer`; consumers that want a hot status snapshot
     *  use this instead of `getPeers.pipe(Effect.map(filter…length))`. */
    readonly getActiveCount: Effect.Effect<number>;
  }
>()("consensus/PeerManager") {}

/** In-memory peer manager implementation. */
export const PeerManagerLive = Effect.gen(function* () {
  const slotClock = yield* SlotClock;
  const stallTimeoutMs = yield* StallTimeoutMs;
  const peers = yield* Ref.make(HashMap.empty<string, PeerState>());
  // Cached active-count, updated atomically with `peers` on add/remove.
  // Avoids the O(n) `HashMap.reduce` walk that the prior implementation
  // ran on every PeerCount metric update.
  const activeCount = yield* Ref.make(0);

  return {
    addPeer: (peerId: string, address?: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.modify(peers, (m) => {
            const delta = activeCountDelta(m, peerId, "connecting");
            const next = HashMap.set(m, peerId, {
              peerId,
              address: address ?? peerId,
              status: "connecting",
              tip: undefined,
              lastActivityMs: Number(now),
              headersReceived: 0,
            });
            return [delta, next] as const;
          }),
        ),
        Effect.flatMap((delta) =>
          Ref.updateAndGet(activeCount, (c) => c + delta).pipe(
            Effect.flatMap((c) => Metric.update(PeerCount, c)),
          ),
        ),
        Effect.withSpan(SPAN.PeerConnect, { attributes: { "peer.id": peerId } }),
      ),

    updatePeerTip: (peerId: string, tip: ChainTip) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          // `HashMap.modify` is a no-op when the peer isn't tracked, so
          // unregistered tip notifications drop silently — same semantics
          // as the previous `mapUpdate(...) ?? m` guard. Status moves
          // "connecting" → "syncing" (both active), so `activeCount`
          // doesn't change.
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
      Ref.modify(peers, (m) => {
        const delta = activeCountDelta(m, peerId, "disconnected");
        const next = HashMap.modify(m, peerId, (peer) => ({
          ...peer,
          status: "disconnected" as const,
        }));
        return [delta, next] as const;
      }).pipe(
        Effect.flatMap((delta) =>
          Ref.updateAndGet(activeCount, (c) => c + delta).pipe(
            Effect.flatMap((c) => Metric.update(PeerCount, c)),
          ),
        ),
        Effect.withSpan(SPAN.PeerDisconnect, { attributes: { "peer.id": peerId } }),
      ),

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
          // Filter eligible-and-past-timeout entries once, then reduce them
          // into the new HashMap. Each `HashMap.set` is an O(log n)
          // structural-sharing update, so k stalled peers cost O(k log n).
          // Stalls are rare (typically 0 per tick) so the filter result
          // stays tiny; replaces the prior `let next = m` accumulator that
          // the CLAUDE.md `.reduce` / `Array.from` rule discourages.
          const stalledEntries = [...HashMap.entries(m)].filter(
            ([, peer]) =>
              isEligibleForStall(peer) && nowMs - peer.lastActivityMs > stallTimeoutMs,
          );
          const next = stalledEntries.reduce(
            (acc, [id, peer]) => HashMap.set(acc, id, { ...peer, status: "stalled" }),
            m,
          );
          const stalled: ReadonlyArray<string> = stalledEntries.map(([id]) => id);
          return [stalled, next] as const;
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

    getActiveCount: Ref.get(activeCount),
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
