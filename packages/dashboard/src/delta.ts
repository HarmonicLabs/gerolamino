/**
 * delta.ts — wire format for atom-state deltas.
 *
 * Two consumers feed each other through this module:
 *   - The host process (apps/tui, packages/chrome-ext background SW)
 *     calls `buildDeltaJson(registry)` to snapshot every dashboard atom
 *     into a JSON string.
 *   - The render context (Bun.WebView SPA, Chrome extension popup) calls
 *     `applyDelta(registry, raw)` to decode that string back into atom
 *     updates on its own mirror registry.
 *
 * **Stable delta keys** (rename only with coordinated host updates):
 *   `nodeState`, `peers`, `bootstrap`, `networkInfo`, `chainEventLog`,
 *   `mempoolSnapshot`, `syncSparkline` — each maps 1:1 to the exported
 *   atom in `atoms/node-state.ts`. Hosts always emit the full snapshot;
 *   receivers fold unconditionally (no initial-vs-delta distinction).
 *
 * Native types `bigint` and `Uint8Array` don't survive plain JSON, so we
 * tag them at encode time and re-hydrate at decode time:
 *
 *   bigint     ↔ `{ __t: "bigint", v: string }`
 *   Uint8Array ↔ `{ __t: "bytes",  v: hex }`
 *
 * After re-hydration the result is fed through `Schema.decodeUnknownSync`
 * against the canonical `DeltaSchema` — atom value Schemas are the single
 * source of truth, so any wire-format drift surfaces as a typed
 * `SchemaError` at the boundary instead of being absorbed by an `as never`
 * cast and silently corrupting downstream state.
 *
 * All writes land inside `Atom.batch(...)`; derived atoms
 * (`slotsBehindAtom`, `syncPercentLabelAtom`, `mempoolSizeAtom`,
 * `mempoolFeeP50Atom`) recompute exactly once per delta instead of once
 * per atom. The producer always emits the full snapshot; the broadcast
 * fiber dedups consecutive identical strings before publishing.
 */
import { Effect, Schema } from "effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import * as Atom from "effect/unstable/reactivity/Atom";
import {
  BootstrapProgress,
  bootstrapAtom,
  ChainEventEntry,
  chainEventLogAtom,
  MempoolEntry,
  mempoolSnapshotAtom,
  NetworkInfo,
  networkInfoAtom,
  NodeState,
  nodeStateAtom,
  PeerInfo,
  peersAtom,
  pushChainEventLog,
  pushMempoolSnapshot,
  syncSparklineAtom,
} from "./atoms";

/** `JSON.stringify` replacer: BigInt + Uint8Array → tagged objects. */
export const replacer = (_key: string, value: unknown): unknown => {
  if (typeof value === "bigint") return { __t: "bigint", v: value.toString() };
  if (value instanceof Uint8Array) return { __t: "bytes", v: value.toHex() };
  return value;
};

const isWireTagged = (value: unknown): value is { readonly __t: string; readonly v: string } => {
  if (typeof value !== "object" || value === null) return false;
  if (!("__t" in value) || !("v" in value)) return false;
  const tag = Reflect.get(value, "__t");
  const payload = Reflect.get(value, "v");
  return typeof tag === "string" && typeof payload === "string";
};

/** `JSON.parse` reviver: tagged objects → BigInt + Uint8Array. */
export const reviver = (_key: string, value: unknown): unknown => {
  if (!isWireTagged(value)) return value;
  switch (value.__t) {
    case "bigint":
      return BigInt(value.v);
    case "bytes":
      return Uint8Array.fromHex(value.v);
    default:
      return value;
  }
};

/**
 * Single source of truth for the wire shape. Each field is
 * `Schema.optionalKey` (key may be absent) so the producer can emit
 * partial deltas during phase transitions without forcing the receiver
 * to fabricate placeholders. Built directly from the atom-side Schemas
 * so adding a new field to (e.g.) `BootstrapProgress` propagates to the
 * delta validator without any rewrite here.
 */
const DeltaSchema = Schema.Struct({
  nodeState: Schema.optionalKey(NodeState),
  peers: Schema.optionalKey(Schema.Array(PeerInfo)),
  bootstrap: Schema.optionalKey(BootstrapProgress),
  networkInfo: Schema.optionalKey(NetworkInfo),
  chainEventLog: Schema.optionalKey(Schema.Array(ChainEventEntry)),
  mempoolSnapshot: Schema.optionalKey(Schema.Array(MempoolEntry)),
  syncSparkline: Schema.optionalKey(Schema.Array(Schema.Number)),
});
export type Delta = typeof DeltaSchema.Type;

const DELTA_SHAPE_ERROR =
  "[delta.ts] applyDelta: wire-format drift — payload failed Delta shape check";

const applyDeltaFailed = (cause: unknown) =>
  new Error("[delta.ts] applyDelta: failed (registry may be partially updated)", {
    cause,
  });

/** Hoisted shape guard — `Schema.is` is 5-10× faster than
 *  `decodeUnknownSync` because it skips transformations and only checks
 *  structure. The wire format already round-trips bigint/Uint8Array
 *  through the JSON.parse reviver, so values are in their final shape
 *  by the time we validate them; we only need to verify the shape, not
 *  re-parse it. Throwing on shape mismatch surfaces wire drift the same
 *  way the prior `decodeUnknownSync` did. */
const isDelta = Schema.is(DeltaSchema);

/** Parse wire JSON and shape-check against `DeltaSchema`. */
const parseDeltaWire = (raw: string): Delta => {
  const parsed: unknown = JSON.parse(raw, reviver);
  if (!isDelta(parsed)) {
    throw new Error(DELTA_SHAPE_ERROR);
  }
  return parsed;
};

/** Write a validated delta into `registry` inside a single `Atom.batch`. */
const writeDeltaToRegistry = (registry: AtomRegistry.AtomRegistry, delta: Delta): void => {
  Atom.batch(() => {
    if (delta.nodeState !== undefined) registry.set(nodeStateAtom, delta.nodeState);
    if (delta.peers !== undefined) registry.set(peersAtom, delta.peers);
    if (delta.bootstrap !== undefined) registry.set(bootstrapAtom, delta.bootstrap);
    if (delta.networkInfo !== undefined) registry.set(networkInfoAtom, delta.networkInfo);
    if (delta.chainEventLog !== undefined) pushChainEventLog(registry, delta.chainEventLog);
    if (delta.mempoolSnapshot !== undefined) {
      pushMempoolSnapshot(registry, delta.mempoolSnapshot);
    }
    if (delta.syncSparkline !== undefined) {
      registry.set(syncSparklineAtom, delta.syncSparkline);
    }
  });
};

/**
 * Snapshot every atom the renderer needs into a JSON string. Always emits
 * the full snapshot; the broadcast fiber dedups consecutive identical
 * strings before publishing, so steady-state cost is one `JSON.stringify`
 * per tick.
 */
export const buildDeltaJson = (registry: AtomRegistry.AtomRegistry): string => {
  const delta: Delta = {
    nodeState: registry.get(nodeStateAtom),
    peers: registry.get(peersAtom),
    bootstrap: registry.get(bootstrapAtom),
    networkInfo: registry.get(networkInfoAtom),
    chainEventLog: registry.get(chainEventLogAtom),
    mempoolSnapshot: registry.get(mempoolSnapshotAtom),
    syncSparkline: registry.get(syncSparklineAtom),
  };
  return JSON.stringify(delta, replacer);
};

/**
 * Decode a JSON string produced by `buildDeltaJson` and write each
 * present field into the supplied registry. Sparkline replaces the full
 * ring (the host is authoritative); chain-event log + mempool go through
 * their bounded push helpers so the renderer-side caps stay enforced.
 *
 * Returns `Effect<void, Error>`: the Effect channel surfaces wire-format
 * drift (shape check fail) AND any throw inside the `Atom.batch`
 * callback. Callers compose via `Stream.runForEach(stream, applyDelta)`
 * etc.; the outer `Effect.catch` then routes errors to `Effect.logWarning`
 * + reconnect rather than silently corrupting registry state.
 *
 * `Atom.batch` defers derived-atom recomputation until every `set`
 * lands, so the seven possible writes incur a single dependency-flush
 * per delta — `slotsBehindAtom`, `mempoolFeeP50Atom`, etc. each recompute
 * at most once, regardless of which atoms changed.
 */
export const applyDelta = (
  registry: AtomRegistry.AtomRegistry,
  raw: string,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const delta = yield* Effect.try({
      try: () => parseDeltaWire(raw),
      catch: applyDeltaFailed,
    });
    yield* Effect.try({
      try: () => writeDeltaToRegistry(registry, delta),
      catch: applyDeltaFailed,
    });
  });
