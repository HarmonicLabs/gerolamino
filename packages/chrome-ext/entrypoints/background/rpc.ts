/**
 * Chrome extension RPC endpoints — typed, schema-validated communication
 * between background service worker, popup, and OPFS worker.
 *
 * Uses Effect RPC for type-safe, validated messaging with automatic
 * serialization and error handling.
 */
import { Effect, Option, Queue, Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

// ---------------------------------------------------------------------------
// Sync State Schema
// ---------------------------------------------------------------------------

export const SyncStatus = Schema.Literals([
  "idle",
  "connecting",
  "bootstrapping",
  "syncing",
  "caught-up",
  "error",
]);
export type SyncStatus = typeof SyncStatus.Type;

/** Granular bootstrap sub-phase so the popup can render a responsive label. */
export const BootstrapPhase = Schema.Literals([
  "idle",
  "awaiting-init",
  "awaiting-ledger-state",
  "decoding-ledger-state",
  "writing-accounts",
  "receiving-utxos",
  "receiving-blocks",
  "writing-stake",
  "complete",
]);
export type BootstrapPhase = typeof BootstrapPhase.Type;

export class SyncState extends Schema.Class<SyncState>("SyncState")({
  status: SyncStatus,
  bootstrapPhase: BootstrapPhase,
  protocolMagic: Schema.Number,
  snapshotSlot: Schema.String,
  totalChunks: Schema.Number,
  totalBlobEntries: Schema.Number,
  blocksReceived: Schema.Number,
  blobEntriesReceived: Schema.Number,
  ledgerStateReceived: Schema.Boolean,
  ledgerStateDecoded: Schema.Boolean,
  accountsWritten: Schema.Number,
  totalAccounts: Schema.optional(Schema.Number),
  stakeEntriesWritten: Schema.Number,
  totalStakeEntries: Schema.optional(Schema.Number),
  bootstrapComplete: Schema.Boolean,
  lastError: Schema.optional(Schema.String),
  lastUpdated: Schema.Number,
  /** Relay sync fields — populated after bootstrap completes. */
  tipSlot: Schema.optional(Schema.String),
  currentSlot: Schema.optional(Schema.String),
  epochNumber: Schema.optional(Schema.String),
  blocksProcessed: Schema.optional(Schema.Number),
  syncPercent: Schema.optional(Schema.Number),
  peerCount: Schema.optional(Schema.Number),
  gsmState: Schema.optional(Schema.String),
  /** Peer list — tipSlot as string (chrome.storage.session is JSON-only). */
  peers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        status: Schema.String,
        tipSlot: Schema.String,
      }),
    ),
  ),
  /** Network info — derived from Init protocolMagic + bootstrap URL. */
  network: Schema.optional(Schema.String),
  relayHost: Schema.optional(Schema.String),
  relayPort: Schema.optional(Schema.Number),
}) {}

export const INITIAL_STATE = new SyncState({
  status: "idle",
  bootstrapPhase: "idle",
  protocolMagic: 0,
  snapshotSlot: "0",
  totalChunks: 0,
  totalBlobEntries: 0,
  blocksReceived: 0,
  blobEntriesReceived: 0,
  ledgerStateReceived: false,
  ledgerStateDecoded: false,
  accountsWritten: 0,
  stakeEntriesWritten: 0,
  bootstrapComplete: false,
  lastUpdated: 0,
});

// ---------------------------------------------------------------------------
// RPC Endpoints: Popup → Background
// ---------------------------------------------------------------------------

/** Get the current sync state. */
class GetSyncState extends Rpc.make("GetSyncState", {
  success: SyncState,
}) {}

/** Start syncing (bootstrap then genesis fallback). */
class StartSync extends Rpc.make("StartSync", {
  success: Schema.Struct({ ok: Schema.Boolean }),
}) {}

/** Stream sync state updates (pushed from background as state changes). */
class StreamSyncState extends Rpc.make("StreamSyncState", {
  success: SyncState,
  stream: true,
}) {}

// ---------------------------------------------------------------------------
// RPC Group
// ---------------------------------------------------------------------------

/**
 * All RPC endpoints for the Chrome extension.
 *
 * Background service worker implements the server.
 * Popup implements the client.
 */
export const NodeRpcs = RpcGroup.make(GetSyncState, StartSync, StreamSyncState);
