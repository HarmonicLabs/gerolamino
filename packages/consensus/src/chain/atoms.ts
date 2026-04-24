/**
 * Reactivity Atoms — live in-process state cells the UI subscribes to.
 *
 * Publishes chain-level state derived from `ChainEventStream` into
 * `Atom.Writable` cells held by an `AtomRegistry`. Consumers (TUI
 * dashboard, browser extension) subscribe through `AtomRegistry.subscribe`
 * / `@effect/atom-solid`, or over the wire via `NodeRpcGroup.SubscribeAtoms`
 * streaming RPC (plan Phase 5).
 *
 * Architecture (plan Tier-1 §6 + research wave 4 confirmations):
 *   - Module-level `Atom.Writable<T>` cells declare the UI-visible
 *     state shape. They are identity-stable so consumers can import
 *     the same atom symbol from anywhere.
 *   - A daemon fiber subscribes to `ChainEventStream.stream` and calls
 *     `AtomRegistry.set(atom, value)` — the idiomatic external mutation
 *     path per `AtomRegistry.ts:50` (the Writable's own `.write(ctx)`
 *     is reserved for derived atoms running inside a reactivity pass).
 *   - `EventLog.groupReactivity(ChainEventGroup, keys)` ALSO wires per-
 *     event invalidation so `Reactivity.query` / `Reactivity.stream`
 *     based derived computations (e.g., "validators this epoch",
 *     cached leader-schedule derivations) auto-recompute when the
 *     journal accepts an event.
 *
 * Atoms emit values by replacement (not deltas). UI side applies
 * `Atom.debounce(source, "16 millis")` to bound render cadence; this
 * module publishes unconstrained.
 */
import { Effect, Layer, PubSub } from "effect";
import { EventLog } from "effect/unstable/eventlog";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRegistryModule from "effect/unstable/reactivity/AtomRegistry";
import {
  ChainEvent,
  type ChainEventType,
  ChainEventGroup,
  ChainEventStream,
  RollbackTarget,
} from "./event-log.ts";

const AtomRegistry = AtomRegistryModule.AtomRegistry;
type AtomRegistry = AtomRegistryModule.AtomRegistry;

/** Chain tip published through `chainTipAtom`. */
export type ChainTipSnapshot = {
  readonly slot: bigint;
  readonly blockNo: bigint;
  readonly hash: Uint8Array;
};

// ---------------------------------------------------------------------------
// Atom declarations — module-level, identity-stable, `Atom.Writable`.
// Consumers import + subscribe; the daemon is the only writer.
// ---------------------------------------------------------------------------

// All atoms are wrapped in `Atom.keepAlive` so the `AtomRegistry` doesn't
// schedule their nodes for removal after a read/write. Without keepAlive,
// `Atom.make(x)` defaults to auto-removal, which means the daemon's
// `registry.set(atom, v)` creates a node that gets swept before any
// subsequent reader sees the new value. See `AtomRegistry.ts:421` + its
// `scheduleAtomRemoval` path for the underlying behavior.

/** Current chain tip. `undefined` until the first tip-bearing event. */
export const chainTipAtom = Atom.keepAlive(Atom.make<ChainTipSnapshot | undefined>(undefined));

/** Block count. Monotonic on `BlockAccepted`; reset on rollback-to-origin. */
export const chainLengthAtom = Atom.keepAlive(Atom.make(0));

/** Current epoch. `undefined` until first `EpochBoundary`. */
export const epochAtom = Atom.keepAlive(Atom.make<bigint | undefined>(undefined));

/** Evolved epoch nonce — 32-byte derived value active from `epochAtom`. */
export const epochNonceAtom = Atom.keepAlive(Atom.make<Uint8Array | undefined>(undefined));

/** Rolling rollback counter — useful for GSM health + dashboard incidents. */
export const rollbackCountAtom = Atom.keepAlive(Atom.make(0));

// ---------------------------------------------------------------------------
// Reactivity keys — `EventLog.groupReactivity` wires these so any effect
// composed with `Reactivity.query(effect, keys)` / `Reactivity.stream(...)`
// recomputes automatically when the matching event commits.
// ---------------------------------------------------------------------------

/** Stable namespaced invalidation keys for `Reactivity.{query,stream,mutation}`. */
export const CHAIN_REACTIVITY_KEYS = {
  tip: "chain.tip",
  length: "chain.length",
  epoch: "chain.epoch",
  epochNonce: "chain.epoch.nonce",
  rollback: "chain.rollback",
} as const;

/**
 * `EventLog.groupReactivity` layer — maps each `ChainEventGroup` tag to
 * the `Reactivity` keys it invalidates. Composes through `EventLog.Registry`
 * at layer construction. Consumers compose this into their stack when they
 * want EventLog writes to drive `Reactivity.query`/`stream` recomputation.
 */
export const ChainReactivityKeysLayer = EventLog.groupReactivity(ChainEventGroup, {
  BlockAccepted: [CHAIN_REACTIVITY_KEYS.tip, CHAIN_REACTIVITY_KEYS.length],
  TipAdvanced: [CHAIN_REACTIVITY_KEYS.tip],
  RolledBack: [
    CHAIN_REACTIVITY_KEYS.tip,
    CHAIN_REACTIVITY_KEYS.length,
    CHAIN_REACTIVITY_KEYS.rollback,
  ],
  EpochBoundary: [CHAIN_REACTIVITY_KEYS.epoch, CHAIN_REACTIVITY_KEYS.epochNonce],
});

// ---------------------------------------------------------------------------
// Daemon — subscribes to ChainEventStream + mirrors each event into atoms.
// ---------------------------------------------------------------------------

const applyRollback = (
  registry: AtomRegistry,
  payload: Extract<ChainEventType, { _tag: "RolledBack" }>,
): void => {
  registry.update(rollbackCountAtom, (n) => n + 1);
  RollbackTarget.match(payload.to, {
    RealPoint: (point) => {
      registry.update(chainLengthAtom, (n) => Math.max(0, n - payload.depth));
      // Tip slot drops to the rollback point; blockNo is unknown without
      // ledger-state introspection, so we set it to the current length
      // which is an upper bound.
      const current = registry.get(chainLengthAtom);
      registry.set(chainTipAtom, {
        slot: point.slot,
        blockNo: BigInt(current),
        hash: point.hash,
      });
    },
    Origin: () => {
      registry.set(chainTipAtom, undefined);
      registry.set(chainLengthAtom, 0);
    },
  });
};

const applyEvent = (registry: AtomRegistry, event: ChainEventType): Effect.Effect<void> =>
  Effect.sync(() =>
    ChainEvent.match(event, {
      BlockAccepted: (p) => {
        registry.set(chainTipAtom, { slot: p.slot, blockNo: p.blockNo, hash: p.hash });
        registry.update(chainLengthAtom, (n) => n + 1);
      },
      TipAdvanced: (p) => {
        registry.set(chainTipAtom, { slot: p.slot, blockNo: p.blockNo, hash: p.hash });
      },
      RolledBack: (p) => applyRollback(registry, p),
      EpochBoundary: (p) => {
        registry.set(epochAtom, p.toEpoch);
        registry.set(epochNonceAtom, p.epochNonce);
      },
    }),
  );

/**
 * Layer that forks a daemon subscribing to `ChainEventStream` and
 * mirroring each event into the module-level atoms. Consumers compose
 * `ChainAtomsLive` into their app stack; the daemon's lifetime is
 * bounded by the layer's scope.
 *
 * Dependencies: `ChainEventStream` + `AtomRegistry` (consumers provide
 * `AtomRegistry.layer` — the default in-memory registry — or a
 * scheduled variant).
 */
export const ChainAtomsLive: Layer.Layer<never, never, ChainEventStream | AtomRegistry> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const events = yield* ChainEventStream;
      const registry = yield* AtomRegistry;
      // Materialize the subscription synchronously BEFORE forking the
      // consumer loop — if we passed `events.stream` to `forkScoped` the
      // subscription registration happens asynchronously on first pull,
      // so writes published between layer-init-complete and the fiber's
      // first PubSub.take would slip past.
      const subscription = yield* events.subscribe;
      yield* Effect.forkScoped(
        Effect.forever(
          PubSub.take(subscription).pipe(Effect.flatMap((event) => applyEvent(registry, event))),
        ),
      );
    }),
  );
