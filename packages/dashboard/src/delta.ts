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
import { Schema } from "effect";
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

/** `JSON.parse` reviver: tagged objects → BigInt + Uint8Array. */
export const reviver = (_key: string, value: unknown): unknown => {
  if (
    typeof value === "object" &&
    value !== null &&
    "__t" in value &&
    "v" in value &&
    typeof (value as { v: unknown }).v === "string"
  ) {
    const tagged = value as { __t: string; v: string };
    switch (tagged.__t) {
      case "bigint":
        return BigInt(tagged.v);
      case "bytes":
        return Uint8Array.fromHex(tagged.v);
    }
  }
  return value;
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

/** Hoisted decoder — `Schema.decodeUnknownSync` materialises a parser
 *  closure on first call; reusing the bound function keeps the per-tick
 *  cost to one map lookup + the actual decode walk. */
const decodeDelta = Schema.decodeUnknownSync(DeltaSchema);

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
 * `Schema.decodeUnknownSync` throws `SchemaError` on wire-format drift —
 * caller is expected to wrap in a try/catch (typically a host-side
 * `Effect.try` or a `try { applyDelta(...) } catch` in the
 * StorageBridge). Surfacing the failure is preferable to the prior
 * `as never` cast that silently absorbed corrupted state into the
 * registry.
 *
 * `Atom.batch` defers derived-atom recomputation until every `set`
 * lands, so the seven possible writes incur a single dependency-flush
 * per delta — `slotsBehindAtom`, `mempoolFeeP50Atom`, etc. each recompute
 * at most once, regardless of which atoms changed.
 */
export const applyDelta = (registry: AtomRegistry.AtomRegistry, raw: string): void => {
  const parsed: unknown = JSON.parse(raw, reviver);
  const delta = decodeDelta(parsed);
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
