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
 * Field set is the same on both sides; new dashboard atoms must be added
 * here in lockstep with `atoms/node-state.ts`.
 */
import { AtomRegistry } from "effect/unstable/reactivity";
import {
  nodeStateAtom,
  peersAtom,
  bootstrapAtom,
  networkInfoAtom,
  chainEventLogAtom,
  mempoolSnapshotAtom,
  syncSparklineAtom,
  pushChainEventLog,
  pushMempoolSnapshot,
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
 * Snapshot every atom the renderer needs into a JSON string. Always emits
 * the full snapshot; the broadcast fiber dedups consecutive identical
 * strings before publishing, so steady-state cost is one `JSON.stringify`
 * per tick.
 */
export const buildDeltaJson = (registry: AtomRegistry.AtomRegistry): string => {
  const delta = {
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

/** Delta payload shape. Each field is optional — the broadcast fiber
 *  always sends the full snapshot, but the receiver tolerates partials. */
export type Delta = {
  readonly nodeState?: typeof nodeStateAtom extends { Type: infer T } ? T : unknown;
  readonly peers?: ReadonlyArray<unknown>;
  readonly bootstrap?: unknown;
  readonly networkInfo?: unknown;
  readonly chainEventLog?: ReadonlyArray<unknown>;
  readonly mempoolSnapshot?: ReadonlyArray<unknown>;
  readonly syncSparkline?: ReadonlyArray<number>;
};

/**
 * Decode a JSON string produced by `buildDeltaJson` and write each field
 * into the supplied registry. Sparkline replaces the full ring (the host
 * is authoritative); chain-event log + mempool go through their bounded
 * push helpers so the renderer-side caps stay enforced.
 */
export const applyDelta = (registry: AtomRegistry.AtomRegistry, raw: string): void => {
  const delta = JSON.parse(raw, reviver) as Delta;
  if (delta.nodeState) registry.set(nodeStateAtom, delta.nodeState as never);
  if (delta.peers) registry.set(peersAtom, delta.peers as never);
  if (delta.bootstrap) registry.set(bootstrapAtom, delta.bootstrap as never);
  if (delta.networkInfo) registry.set(networkInfoAtom, delta.networkInfo as never);
  if (delta.chainEventLog) pushChainEventLog(registry, delta.chainEventLog as never);
  if (delta.mempoolSnapshot) pushMempoolSnapshot(registry, delta.mempoolSnapshot as never);
  if (delta.syncSparkline) registry.set(syncSparklineAtom, delta.syncSparkline);
};
