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

export const SyncStatus = Schema.Literals(["idle", "connecting", "bootstrapping", "syncing", "error"]);
export type SyncStatus = typeof SyncStatus.Type;

export class SyncState extends Schema.Class<SyncState>("SyncState")({
  status: SyncStatus,
  protocolMagic: Schema.Number,
  snapshotSlot: Schema.String,
  totalChunks: Schema.Number,
  totalBlobEntries: Schema.Number,
  blocksReceived: Schema.Number,
  blobEntriesReceived: Schema.Number,
  ledgerStateReceived: Schema.Boolean,
  bootstrapComplete: Schema.Boolean,
  lastError: Schema.optional(Schema.String),
  lastUpdated: Schema.Number,
}) {}

export const INITIAL_STATE = new SyncState({
  status: "idle",
  protocolMagic: 0,
  snapshotSlot: "0",
  totalChunks: 0,
  totalBlobEntries: 0,
  blocksReceived: 0,
  blobEntriesReceived: 0,
  ledgerStateReceived: false,
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
export const NodeRpcs = RpcGroup.make(
  GetSyncState,
  StartSync,
  StreamSyncState,
);
