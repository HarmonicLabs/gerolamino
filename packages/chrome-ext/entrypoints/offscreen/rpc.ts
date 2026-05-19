/**
 * Offscreen RPC group — typed Effect RPC for SW ↔ offscreen-document.
 *
 * Phase D Step 1 scaffolding (see `project_chrome_offscreen_redesign.md`).
 * Defines the canonical method surface for the offscreen daemon as the
 * migration moves the Effect runtime + AtomRegistry + bootstrap WS +
 * consensus driver out of the SW. The SW becomes a thin RPC gateway;
 * the offscreen owns persistent compute under the `WORKERS` reason
 * (Chrome 124+, indefinite lifetime).
 *
 * Initial methods (Step 1 — deliberately small so the BroadcastChannel
 * `RpcServer.Protocol` layer can be exercised end-to-end without
 * touching consensus / atoms / bootstrap):
 *   - `Ping`               — round-trip health check
 *   - `RequestRestart`     — re-trigger the bootstrap pipeline
 *
 * Step 1 methods (live):
 *   - `Ping`                 — round-trip health check (live)
 *   - `RequestRestart`       — re-trigger the bootstrap-sync pipeline
 *   - `SubscribeAtomDeltas`  — streaming `Stream<string>` of JSON deltas
 *
 * Methods reserved for upcoming steps:
 *   Step 2/3 follow-ups:
 *     - `RequestAtomSnapshot`  — full snapshot on demand (reconnect path)
 *     - `GetSyncState`         — current bootstrap / sync phase + tip
 *     - `RequestSnapshot`      — re-bootstrap from a clean state
 *   Step 4 (parallel crypto pool):
 *     - (internal — Worker pool lives inside offscreen, no RPC surface)
 *
 * Wire format: BroadcastChannel structured-clone is exact for the
 * primitives we use (string, bigint, Uint8Array, plain records).
 */
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

/** Round-trip health check. Verifies the BroadcastChannel + RPC
 *  pipeline is wired correctly without depending on any offscreen-side
 *  service. Returns the offscreen's wallclock so the SW can log a
 *  cross-process time delta during boot. */
export class Ping extends Rpc.make("Ping", {
  success: Schema.Struct({
    ok: Schema.Boolean,
    timeMs: Schema.Number,
  }),
}) {}

/** Re-trigger the bootstrap-sync pipeline. Idempotent: if a sync is
 *  already in flight the offscreen returns `{ alreadyRunning: true }`
 *  without restarting; otherwise returns `{ alreadyRunning: false,
 *  requestId }` and starts a fresh attempt. Progress events are
 *  observed via `SubscribeAtomDeltas`. */
export class RequestRestart extends Rpc.make("RequestRestart", {
  success: Schema.Struct({
    alreadyRunning: Schema.Boolean,
    requestId: Schema.optional(Schema.String),
  }),
}) {}

/** Streaming endpoint: emits JSON delta strings produced by
 *  `dashboard/delta::buildDeltaJson`. The offscreen's broadcast fiber
 *  publishes to its internal `PubSub<string>` every
 *  `DELTA_PUSH_INTERVAL_MS` (currently 100 ms) and dedups identity-stable
 *  ticks; this RPC is the per-subscriber tap.
 *
 *  Today (Step 2 wire-up): the offscreen-side handler returns the
 *  stream from a new `OffscreenAtomBroadcast` PubSub. The fiber that
 *  feeds it is empty — atom writers still live in the SW. Once Step 3
 *  moves bootstrap-sync into the offscreen, the fiber starts producing
 *  real deltas and the SW's `BroadcastDeltas` (popup-facing) becomes
 *  a relay over this stream. */
export class SubscribeAtomDeltas extends Rpc.make("SubscribeAtomDeltas", {
  success: Schema.String,
  stream: true,
}) {}

/** Upload one chunk of a Mithril snapshot file to OPFS via the
 *  offscreen → lsm-worker pipeline. The popup reads the user-dropped
 *  file in 1 MiB Uint8Array slices and calls this once per chunk;
 *  the offscreen relays each call to the worker's `LsmUploadChunk`,
 *  which writes via `FileSystemSyncAccessHandle.write` at `(path,
 *  offset)`. When `final` is true the worker flushes + closes the
 *  handle. After every file in the snapshot is fully uploaded, the
 *  popup calls `ReopenAfterSnapshot` to bring the lsm-tree session
 *  back online against the populated OPFS tree. */
export class UploadSnapshotChunk extends Rpc.make("UploadSnapshotChunk", {
  payload: {
    path: Schema.String,
    offset: Schema.Number,
    bytes: Schema.Uint8Array,
    final: Schema.Boolean,
  },
  success: Schema.Void,
}) {}

/** Reopen the lsm-tree session against the post-upload OPFS tree.
 *  Idempotent — calling twice in a row is a no-op the second time
 *  (the worker's session is already pointing at the fresh data). */
export class ReopenAfterSnapshot extends Rpc.make("ReopenAfterSnapshot", {
  success: Schema.Void,
}) {}

/** Inspect the OPFS lsm-tree session state. Used by the popup on
 *  mount to decide whether to offer a "resume from existing
 *  snapshot" affordance instead of forcing the user to re-upload.
 *  Mirrors the `LsmInspectOpfs` worker-side RPC; the offscreen
 *  forwards directly. */
export class InspectOpfsSnapshot extends Rpc.make("InspectOpfsSnapshot", {
  success: Schema.Struct({
    hasSession: Schema.Boolean,
    hasSnapshots: Schema.Boolean,
    byteCount: Schema.Number,
    lastModifiedMs: Schema.Number,
  }),
}) {}

/** All offscreen RPC endpoints. SW implements the client; offscreen
 *  implements the server. */
export const OffscreenRpcs = RpcGroup.make(
  Ping,
  RequestRestart,
  SubscribeAtomDeltas,
  UploadSnapshotChunk,
  ReopenAfterSnapshot,
  InspectOpfsSnapshot,
);
