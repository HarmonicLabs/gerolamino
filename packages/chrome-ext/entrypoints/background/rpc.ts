/**
 * Chrome extension RPC endpoints.
 *
 * The wire format mirrors `apps/tui`'s HTTP+WS protocol: the SW publishes
 * a JSON delta string per atom-registry change (shared encoder lives in
 * `dashboard/src/delta.ts`), and the popup decodes via the matching
 * `applyDelta` on its own mirror registry.
 *
 * Methods:
 *   - `BroadcastDeltas` — streaming. Each subscriber gets the current
 *     snapshot once (`Stream.concat(initial, …)`) followed by every
 *     subsequent published delta. Replaces the prior
 *     `chrome.storage.session.onChanged` bridge + per-field translator.
 *   - `StartSync` — control: kicks the bootstrap pipeline (currently
 *     auto-starts on SW boot too; this endpoint exists for a future
 *     "Start Sync" button on the popup).
 *   - `UploadSnapshotChunk` — popup-driven snapshot upload. The popup
 *     reads a Mithril snapshot directory in 1 MiB chunks and forwards
 *     each through this relay to the offscreen, which routes to the
 *     lsm-worker's OPFS-write handlers. Three hops total (popup → SW →
 *     offscreen → worker); each chunk is structured-cloned at each
 *     postMessage boundary. ~50 MiB snapshots at 50 chunks finish in
 *     ~250 ms of hop overhead — acceptable.
 *   - `ReopenAfterSnapshot` — popup signals the worker to swap its
 *     active lsm-tree session for one rooted at the freshly-uploaded
 *     OPFS tree. Idempotent.
 */
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

/** Streaming endpoint: emits JSON delta strings produced by
 *  `buildDeltaJson` in the dashboard package. */
class BroadcastDeltas extends Rpc.make("BroadcastDeltas", {
  success: Schema.String,
  stream: true,
}) {}

/** Round-trip health check — relays to offscreen `Ping` (no lsm-worker / OPFS). */
class Ping extends Rpc.make("Ping", {
  success: Schema.Struct({
    ok: Schema.Boolean,
    timeMs: Schema.Number,
  }),
}) {}

/** Control endpoint: forces a bootstrap-sync restart. */
class StartSync extends Rpc.make("StartSync", {
  success: Schema.Struct({ ok: Schema.Boolean }),
}) {}

/** Snapshot upload — single chunk. `path` is the OPFS-relative file
 *  path (e.g. `lsm/active/0/data`); `offset` is the position to
 *  write at (callers stream sequentially but the protocol supports
 *  random-access); `final` signals the last chunk of this file. */
class UploadSnapshotChunk extends Rpc.make("UploadSnapshotChunk", {
  payload: {
    path: Schema.String,
    offset: Schema.Number,
    bytes: Schema.Uint8Array,
    final: Schema.Boolean,
  },
  success: Schema.Void,
}) {}

/** Bring the lsm-tree session back online against the post-upload
 *  OPFS tree. Idempotent. */
class ReopenAfterSnapshot extends Rpc.make("ReopenAfterSnapshot", {
  success: Schema.Void,
}) {}

/** Popup-on-mount probe — returns OPFS lsm-tree state so the UI can
 *  offer a "resume from existing snapshot" affordance and skip the
 *  re-upload step. Relays directly to the offscreen's
 *  `InspectOpfsSnapshot` which in turn forwards to the lsm-worker's
 *  `LsmInspectOpfs`. */
class InspectOpfsSnapshot extends Rpc.make("InspectOpfsSnapshot", {
  success: Schema.Struct({
    hasSession: Schema.Boolean,
    hasSnapshots: Schema.Boolean,
    byteCount: Schema.Number,
    lastModifiedMs: Schema.Number,
  }),
}) {}

/** All RPC endpoints. Background SW implements the server; popup
 *  implements the client. */
export const NodeRpcs = RpcGroup.make(
  BroadcastDeltas,
  Ping,
  StartSync,
  UploadSnapshotChunk,
  ReopenAfterSnapshot,
  InspectOpfsSnapshot,
);
