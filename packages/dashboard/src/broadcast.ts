/**
 * broadcast.ts — shared atom-state delta broadcast fiber.
 *
 * Used identically by:
 *   - `apps/tui/src/dashboard/serve.ts` (HTTP+WS host, fans deltas to
 *     browser clients pointed at the dashboard's bundled SPA)
 *   - `packages/chrome-ext/entrypoints/background/dashboard/broadcast.ts`
 *     (chrome-ext SW broadcast PubSub fanned to popup connections via
 *     `chrome.runtime.Port`-backed RPC)
 *
 * Both hosts run the same producer pipeline:
 *   1. Identity-check every dashboard atom against the prior snapshot.
 *   2. If any atom value changed (`===`), build the JSON delta via
 *      `buildDeltaJson` and publish to the supplied `PubSub<string>`.
 *   3. Skip stringify entirely on identity-stable ticks — the
 *      `~150 KB` JSON.stringify dominated the per-tick CPU budget on the
 *      prior string-equality dedup; identity is `O(7 fields)` instead.
 *
 * The fiber composes via `.pipe()` chains (no nested `Effect.gen`) so
 * the data flow stays serialized top-to-bottom.
 */
import { Effect, PubSub, Ref, Schedule } from "effect";
import * as AtomRegistryModule from "effect/unstable/reactivity/AtomRegistry";
import { buildDeltaJson } from "./delta.ts";
import {
  bootstrapAtom,
  chainEventLogAtom,
  mempoolSnapshotAtom,
  networkInfoAtom,
  nodeStateAtom,
  peersAtom,
  syncSparklineAtom,
} from "./atoms";

type AtomRegistry = AtomRegistryModule.AtomRegistry;

/** Snapshot of every atom's current value reference. Object identity
 *  comparison via `===` is exact for atom writes that go through
 *  `registry.set(...)`/`Atom.batch(...)` — those preserve referential
 *  identity when the value didn't change, and produce a fresh reference
 *  on every mutation. So this 7-field record acts as a per-tick "did
 *  any atom change?" sentinel without having to compare the underlying
 *  data shapes. */
type AtomSnapshot = {
  readonly nodeState: unknown;
  readonly peers: unknown;
  readonly bootstrap: unknown;
  readonly networkInfo: unknown;
  readonly chainEventLog: unknown;
  readonly mempoolSnapshot: unknown;
  readonly syncSparkline: unknown;
};

const sampleAtoms = (registry: AtomRegistry): AtomSnapshot => ({
  nodeState: registry.get(nodeStateAtom),
  peers: registry.get(peersAtom),
  bootstrap: registry.get(bootstrapAtom),
  networkInfo: registry.get(networkInfoAtom),
  chainEventLog: registry.get(chainEventLogAtom),
  mempoolSnapshot: registry.get(mempoolSnapshotAtom),
  syncSparkline: registry.get(syncSparklineAtom),
});

/** All-fields-`===` equality. Returns `false` on the first mismatch. */
const snapshotsEqual = (a: AtomSnapshot, b: AtomSnapshot): boolean =>
  a.nodeState === b.nodeState &&
  a.peers === b.peers &&
  a.bootstrap === b.bootstrap &&
  a.networkInfo === b.networkInfo &&
  a.chainEventLog === b.chainEventLog &&
  a.mempoolSnapshot === b.mempoolSnapshot &&
  a.syncSparkline === b.syncSparkline;

const EMPTY_SNAPSHOT: AtomSnapshot = {
  nodeState: undefined,
  peers: undefined,
  bootstrap: undefined,
  networkInfo: undefined,
  chainEventLog: undefined,
  mempoolSnapshot: undefined,
  syncSparkline: undefined,
};

/** One iteration of the producer loop. Hoisted to module scope so the
 *  fiber composes via `.pipe()` (no nested `Effect.gen` per the pipe-style
 *  rule). The `Effect.sync(() => ...)` wrapper makes the sample lazy
 *  so each repeat tick re-reads the registry. */
const tick = (
  registry: AtomRegistry,
  lastSnapshotRef: Ref.Ref<AtomSnapshot>,
  broadcast: PubSub.PubSub<string>,
) =>
  Ref.get(lastSnapshotRef).pipe(
    Effect.flatMap((last) => {
      const current = sampleAtoms(registry);
      if (snapshotsEqual(last, current)) return Effect.void;
      const json = buildDeltaJson(registry);
      return Ref.set(lastSnapshotRef, current).pipe(
        Effect.andThen(PubSub.publish(broadcast, json)),
      );
    }),
  );

/**
 * Spawn a forever-fiber that polls `registry` on `Schedule.fixed`
 * cadence and publishes JSON deltas via `broadcast`. Identity-stable
 * ticks short-circuit before the JSON.stringify step.
 *
 * The returned `Effect<void>` is meant to be `Effect.forkScoped(...)`'d
 * so the fiber's lifetime tracks the calling scope (Layer's lifetime
 * for the chrome-ext path; dashboard-server scope for apps/tui).
 */
export const makeBroadcastFiber = (
  registry: AtomRegistry,
  broadcast: PubSub.PubSub<string>,
  intervalMs: number,
) =>
  Ref.make<AtomSnapshot>(EMPTY_SNAPSHOT).pipe(
    Effect.flatMap((lastSnapshotRef) =>
      Effect.repeat(
        tick(registry, lastSnapshotRef, broadcast),
        Schedule.fixed(`${intervalMs} millis`),
      ),
    ),
  );
