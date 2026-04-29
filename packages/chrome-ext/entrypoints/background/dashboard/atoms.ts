/**
 * Dashboard atom registry for the chrome-ext background service worker.
 *
 * Mirrors `apps/tui/src/dashboard/atoms.ts` exactly: the SW owns the
 * canonical Effect Atom registry, the bootstrap + relay sync pipelines
 * call into the push helpers, and the broadcast fiber serializes the
 * registry into a JSON delta string for the popup over RPC.
 *
 * This file imports from the dashboard package's `./atoms` sub-path so
 * the SW does not pull Solid components into its bundle.
 */
import { Clock, Effect } from "effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import {
  nodeStateAtom,
  bootstrapAtom,
  networkInfoAtom,
  peersAtom,
  appendChainEvent as appendChainEventRaw,
  appendChainEvents as appendChainEventsRaw,
  pushSyncSparklinePoint as pushSyncSparklinePointRaw,
  pushMempoolSnapshot as pushMempoolSnapshotRaw,
} from "dashboard/atoms";
import type {
  NodeState,
  BootstrapProgress,
  NetworkInfo,
  PeerInfo,
  ChainEventEntry,
  MempoolEntry,
} from "dashboard/atoms";

/** Shared AtomRegistry for the SW process. */
export const registry = AtomRegistry.make();

/** Push node state metrics into dashboard atoms. Uses Clock for timestamp. */
export const pushNodeState = (update: Partial<NodeState>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    registry.update(nodeStateAtom, (prev) => ({
      ...prev,
      ...update,
      lastUpdated: now,
    }));
  });

/** Push bootstrap progress into dashboard atoms. */
export const pushBootstrapProgress = (update: Partial<BootstrapProgress>): Effect.Effect<void> =>
  Effect.sync(() => registry.update(bootstrapAtom, (prev) => ({ ...prev, ...update })));

/** Push network info into dashboard atoms. */
export const pushNetworkInfo = (update: Partial<NetworkInfo>): Effect.Effect<void> =>
  Effect.sync(() => registry.update(networkInfoAtom, (prev) => ({ ...prev, ...update })));

/** Push peers list into dashboard atoms. */
export const pushPeers = (peers: readonly PeerInfo[]): Effect.Effect<void> =>
  Effect.sync(() => registry.set(peersAtom, peers));

/** Append one chain event to the bounded ring (1000-cap, defined in dashboard). */
export const appendChainEvent = (event: ChainEventEntry): Effect.Effect<void> =>
  Effect.sync(() => appendChainEventRaw(registry, event));

/** Bulk-append chain events — preferred for journal replay / batched pulls. */
export const appendChainEvents = (events: readonly ChainEventEntry[]): Effect.Effect<void> =>
  Effect.sync(() => appendChainEventsRaw(registry, events));

/** Append one slots-behind sample to the rolling 600-pt sparkline ring. */
export const pushSyncSparklinePoint = (slotsBehind: number): Effect.Effect<void> =>
  Effect.sync(() => pushSyncSparklinePointRaw(registry, slotsBehind));

/** Replace the mempool snapshot atom (capped at 256 server-side). */
export const pushMempoolSnapshot = (entries: readonly MempoolEntry[]): Effect.Effect<void> =>
  Effect.sync(() => pushMempoolSnapshotRaw(registry, entries));
