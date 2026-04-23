/**
 * NodeRpcGroup — main-thread ↔ node-worker boundary for apps/tui's
 * Bun.WebView split (Phase 5).
 *
 * Seven Rpcs:
 *   - Query: GetChainTip, GetPeers, GetMempool, GetSyncStatus
 *   - Command: SubmitTx
 *   - Stream (annotated `Uninterruptible: "server"`): SubscribeChainEvents,
 *     SubscribeAtoms
 *
 * Per wave-2 Correction: streaming RPCs annotate
 * `ClusterSchema.Uninterruptible: "server"` so a main-thread client
 * tearing down mid-stream doesn't kill the server-side source fiber.
 *
 * Rpc-side transport: `RpcClient.layerProtocolWorker({ size: 1,
 * concurrency: 16 })` + `Worker.layerSpawner(fn)` — one long-lived Node
 * Worker, up to 16 in-flight queries + Atom stream subscriptions
 * multiplexed via auto-tracked request-ids. Phase 5 apps/tui spawns the
 * worker; this file just declares the contract.
 */
import { Schema } from "effect";
import * as ClusterSchema from "effect/unstable/cluster/ClusterSchema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import { ChainEvent } from "../chain/event-log.ts";

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

export const ChainTipResult = Schema.Struct({
  slot: Schema.BigInt,
  blockNo: Schema.BigInt,
  hash: Schema.Uint8Array,
});

export const PeerInfo = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  status: Schema.Literals(["connected", "disconnected", "syncing"]),
  tipSlot: Schema.optional(Schema.BigInt),
});

export const TxSummary = Schema.Struct({
  txIdHex: Schema.String,
  sizeBytes: Schema.Number,
  feePerByte: Schema.Number,
});

export const SyncStatus = Schema.Struct({
  synced: Schema.Boolean,
  /** Distance from tip in slots (0 when synced). */
  slotsBehind: Schema.BigInt,
  tipSlot: Schema.BigInt,
  blocksProcessed: Schema.Number,
});

/** Atom-delta payload — key identifies which atom changed, value is encoded. */
export const AtomDelta = Schema.Struct({
  key: Schema.String,
  /** JSON-encoded value. Binary atoms serialize to base64 before ingest. */
  valueJson: Schema.String,
});

// ---------------------------------------------------------------------------
// Rpc declarations
// ---------------------------------------------------------------------------

export class GetChainTip extends Rpc.make("GetChainTip", {
  success: Schema.Option(ChainTipResult),
}) {}

export class GetPeers extends Rpc.make("GetPeers", {
  success: Schema.Array(PeerInfo),
}) {}

export class GetMempool extends Rpc.make("GetMempool", {
  success: Schema.Array(TxSummary),
}) {}

export class GetSyncStatus extends Rpc.make("GetSyncStatus", {
  success: SyncStatus,
}) {}

export class SubmitTx extends Rpc.make("SubmitTx", {
  payload: { txCbor: Schema.Uint8Array },
  success: Schema.Struct({ accepted: Schema.Boolean, reason: Schema.optional(Schema.String) }),
}) {}

/**
 * Stream subscription — emits every `ChainEvent` written through the live
 * EventLog (fan-out via `ChainEventStream`). `Uninterruptible: "server"`
 * so client teardown doesn't kill the server source fiber.
 */
export class SubscribeChainEvents extends Rpc.make("SubscribeChainEvents", {
  success: RpcSchema.Stream(ChainEvent, Schema.Never),
}).annotate(ClusterSchema.Uninterruptible, "server") {}

/** Stream subscription — Atom deltas pushed to the main-thread UI bridge. */
export class SubscribeAtoms extends Rpc.make("SubscribeAtoms", {
  success: RpcSchema.Stream(AtomDelta, Schema.Never),
}).annotate(ClusterSchema.Uninterruptible, "server") {}

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const NodeRpcGroup = RpcGroup.make(
  GetChainTip,
  GetPeers,
  GetMempool,
  GetSyncStatus,
  SubmitTx,
  SubscribeChainEvents,
  SubscribeAtoms,
);
