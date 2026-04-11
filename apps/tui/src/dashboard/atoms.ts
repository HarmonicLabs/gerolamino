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
import { nodeStateAtom, bootstrapAtom, networkInfoAtom, peersAtom } from "dashboard";
import type { NodeState, BootstrapProgress, NetworkInfo, PeerInfo } from "dashboard";

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
