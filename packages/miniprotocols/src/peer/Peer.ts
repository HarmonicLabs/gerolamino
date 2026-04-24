/**
 * `Peer` — Cluster Entity addressed by `peerId`. One entity instance per
 * remote relay, passivates on idle, reactivates via mailbox on next
 * message. Shards across runners via `ShardingConfig.shardsPerGroup`
 * (default 300) so a fleet of peer entities scales horizontally.
 *
 * Service surface (plan §Phase 2e):
 *   - `ConnectToPeer` — opens the bearer socket + runs handshake
 *   - `AdvanceCursor` — persists the ChainSync cursor (Persisted +
 *     WithTransaction so cursor advance + journal entry commit
 *     atomically)
 *   - `GetCursor`  — read the persisted cursor
 *   - `RequestBlocks` — range-fetch against the peer (delegates to
 *     `BlockFetchResolver` under the hood; the entity doesn't hold the
 *     socket connection open between calls, relying on `Pool.makeWithTTL`
 *     for bearer reuse)
 *   - `SubmitTx`    — forward a tx to the peer via TxSubmission2
 *   - `Disconnect`  — tear down cleanly
 *
 * This file ships the **Entity declaration + Rpc contract**. The concrete
 * handler layer is a sibling module (`Peer.handler.ts`, Phase 2e proper)
 * that composes the underlying mini-protocol clients. The declaration is
 * importable + compilable stand-alone so downstream packages (consensus)
 * can write code against the entity surface while the handler is still
 * stubbed.
 */
import { Hash, PrimaryKey, Schema } from "effect";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import { Rpc } from "effect/unstable/rpc";

import { ChainPointSchema, type ChainPoint } from "../protocols/types/ChainPoint";

// ---------------------------------------------------------------------------
// PeerId — the entity address
// ---------------------------------------------------------------------------

/**
 * Stable peer identifier. The addressing key for the Cluster shard map;
 * two handles with the same `value` resolve to the same entity shard.
 * PrimaryKey is the value itself so idempotency across RPCs uses it.
 */
export class PeerId extends Schema.TaggedClass<PeerId>()("PeerId", {
  value: Schema.String,
}) {
  [PrimaryKey.symbol]() {
    return this.value;
  }
  [Hash.symbol](): number {
    return Hash.string(this.value);
  }
}

// ---------------------------------------------------------------------------
// Payloads + errors
// ---------------------------------------------------------------------------

export class PeerError extends Schema.TaggedErrorClass<PeerError>()("peer/PeerError", {
  reason: Schema.String,
}) {}

/**
 * `PeerEndpoint` — network address for opening the bearer. Named
 * distinctly from `PeerAddress` (peer-sharing protocol's on-wire type)
 * to avoid barrel re-export collisions.
 */
export const PeerEndpoint = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  networkMagic: Schema.Number,
});
export type PeerEndpoint = typeof PeerEndpoint.Type;

export const BlockRange = Schema.Struct({
  from: ChainPointSchema,
  to: ChainPointSchema,
});
export type BlockRange = typeof BlockRange.Type;

export const SubmitOutcome = Schema.Union([
  Schema.TaggedStruct("Accepted", { txId: Schema.Uint8Array }),
  Schema.TaggedStruct("Rejected", { txId: Schema.Uint8Array, reason: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type SubmitOutcome = typeof SubmitOutcome.Type;

// ---------------------------------------------------------------------------
// Rpcs — class-based declarations so payload/return types are named,
// importable, and carry their annotations on the class identity.
// ---------------------------------------------------------------------------

/** Open a bearer socket + run handshake. Idempotent per-peer: resubmits
 * collapse to the same connection via the Cluster entity's message dedup. */
export class ConnectToPeer extends Rpc.make("ConnectToPeer", {
  payload: { address: PeerEndpoint },
  success: PeerId,
  error: PeerError,
}) {}

/** Advance the persistent ChainSync cursor. `Persisted` so the cursor
 * survives runner restart; `WithTransaction` so the cursor write + any
 * downstream journal emissions commit atomically. */
export class AdvanceCursor extends Rpc.make("AdvanceCursor", {
  payload: { point: ChainPointSchema },
  // `{ ok: true }` acknowledgement — Entity-level round-trip stubs in
  // beta.50 decode responses through an internal Void schema for their
  // reserved KeepAlive Rpc; keeping the success as a concrete struct
  // side-steps that collision. Real Sharding runtime (Phase 3f) handles
  // Void returns correctly.
  success: Schema.Struct({ ok: Schema.Boolean }),
  error: PeerError,
})
  .annotate(ClusterSchema.Persisted, true)
  .annotate(ClusterSchema.WithTransaction, true) {}

/** Read the persisted cursor. Stale-cursor detection on reactivation is
 * a handler concern (Phase 2e): if the peer rejects a `MsgFindIntersect`
 * at the persisted cursor, reset to genesis per the plan's wave-2
 * correction on exponential-points + intersection. */
export class GetCursor extends Rpc.make("GetCursor", {
  success: Schema.NullOr(ChainPointSchema),
  error: PeerError,
}) {}

/** Request a block range. Delegates internally to `BlockFetchResolver`
 * (deduping, batching, LRU caching); this RPC surface stays narrow so
 * consumers don't have to import the resolver directly. */
export class RequestBlocks extends Rpc.make("RequestBlocks", {
  payload: BlockRange,
  success: Schema.Array(Schema.Uint8Array),
  error: PeerError,
}) {}

/** Forward a tx to the peer via TxSubmission2. `Persisted` so submit
 * requests survive runner restart; the tx-id is the primary key for
 * idempotency. */
export class SubmitTx extends Rpc.make("SubmitTx", {
  payload: { txId: Schema.Uint8Array, txCbor: Schema.Uint8Array },
  success: SubmitOutcome,
  error: PeerError,
}).annotate(ClusterSchema.Persisted, true) {}

/** Clean disconnect — ends the bearer + emits a final `ClientDone` on
 * every protocol. */
export class Disconnect extends Rpc.make("Disconnect", {
  success: Schema.Struct({ ok: Schema.Boolean }),
  error: PeerError,
}) {}

// ---------------------------------------------------------------------------
// Entity declaration — the "type" field ("Peer") is the shard-group name.
// Consumers call `Peer.client` to get a typed RPC client keyed by PeerId.
// ---------------------------------------------------------------------------

export const Peer = Entity.make("Peer", [
  ConnectToPeer,
  AdvanceCursor,
  GetCursor,
  RequestBlocks,
  SubmitTx,
  Disconnect,
]);

// `PeerRegistry` lives in `./handler.ts` now — it needs a
// `SubscriptionRef.make` + `KeyValueStore` at layer-construction time,
// so it's paired with the handlers there rather than the pure Entity
// declaration here.
