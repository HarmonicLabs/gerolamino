/**
 * Dashboard atom registry and push functions.
 *
 * Separated from the JSX dashboard component so the main entry point
 * can import these without triggering Solid.js JSX compilation.
 *
 * All push functions return Effect<void> so they compose naturally
 * inside Effect.gen blocks and use Clock for timestamps.
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

/** Shared AtomRegistry for the TUI process. */
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

/** Bulk-append chain events — preferred for journal replay / batched pulls
 *  since the underlying helper collapses N subscriber notifications into 1. */
export const appendChainEvents = (events: readonly ChainEventEntry[]): Effect.Effect<void> =>
  Effect.sync(() => appendChainEventsRaw(registry, events));

/** Append one slots-behind sample to the rolling 600-pt sparkline ring. */
export const pushSyncSparklinePoint = (slotsBehind: number): Effect.Effect<void> =>
  Effect.sync(() => pushSyncSparklinePointRaw(registry, slotsBehind));

/** Replace the mempool snapshot atom (capped at 256 server-side). */
export const pushMempoolSnapshot = (entries: readonly MempoolEntry[]): Effect.Effect<void> =>
  Effect.sync(() => pushMempoolSnapshotRaw(registry, entries));
