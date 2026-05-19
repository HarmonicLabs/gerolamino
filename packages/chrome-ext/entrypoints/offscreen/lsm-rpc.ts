/**
 * RPC schema for the BlobStore-shaped Worker living inside the
 * offscreen document.
 *
 * The Worker (`workers/lsm-worker.ts`) hosts an `RpcServer` against
 * this group; the offscreen daemon (`lsm-pool.ts`) builds an
 * `RpcClient` over `BrowserWorker` and proxies every method to the
 * worker. The seven methods mirror the `BlobStore` service shape
 * from `lsm-ffi`:
 *
 *   Get / Put / Delete / Has / Scan / PutBatch / DeleteBatch
 *
 * Streams are supported in Effect RPC via `RpcGroup.success` returning
 * a `Stream`-shaped type, but for `Scan` we round-trip an
 * `Array<BlobEntry>` for simplicity. The caller wraps it back in a
 * `Stream.fromIterable` if downstream lazy consumption matters. A
 * future iteration can swap to a true streaming RPC once the
 * back-pressure model is clear.
 *
 * Plus `UploadSnapshot` — the popup-side drag-drop path. Bytes
 * stream in 1 MiB chunks; offscreen writes them to OPFS under
 * `/data/lsm/...`. After the final chunk, the worker re-opens its
 * session against the populated OPFS tree.
 */
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { BlobStoreError } from "lsm-ffi";

const BytesIn = Schema.Uint8Array;
const BytesOut = Schema.Uint8Array;
const BlobEntrySchema = Schema.Struct({
  key: BytesIn,
  value: BytesOut,
});

export class LsmGet extends Rpc.make("LsmGet", {
  payload: { key: BytesIn },
  // `OptionFromNullishOr` is the Schema-encoded form; null on the wire
  // → `Option.none` on decode. The success channel preserves the
  // service's `Option<Uint8Array>` shape without an extra adapter.
  success: Schema.NullOr(BytesOut),
  error: BlobStoreError,
}) {}

export class LsmPut extends Rpc.make("LsmPut", {
  payload: { key: BytesIn, value: BytesIn },
  success: Schema.Void,
  error: BlobStoreError,
}) {}

export class LsmDelete extends Rpc.make("LsmDelete", {
  payload: { key: BytesIn },
  success: Schema.Void,
  error: BlobStoreError,
}) {}

export class LsmHas extends Rpc.make("LsmHas", {
  payload: { key: BytesIn },
  success: Schema.Boolean,
  error: BlobStoreError,
}) {}

export class LsmScan extends Rpc.make("LsmScan", {
  payload: { prefix: BytesIn },
  success: Schema.Array(BlobEntrySchema),
  error: BlobStoreError,
}) {}

export class LsmPutBatch extends Rpc.make("LsmPutBatch", {
  payload: { entries: Schema.Array(BlobEntrySchema) },
  success: Schema.Void,
  error: BlobStoreError,
}) {}

export class LsmDeleteBatch extends Rpc.make("LsmDeleteBatch", {
  payload: { keys: Schema.Array(BytesIn) },
  success: Schema.Void,
  error: BlobStoreError,
}) {}

/** Upload one chunk of a Mithril snapshot tarball. `path` is the
 *  OPFS-relative file path under `/data/lsm/`; `offset` is the byte
 *  position to write at. `final` signals the last chunk for this
 *  file (the worker `fsync`s + closes the handle).
 *
 *  This is a Worker-side RPC because OPFS sync handles only work in
 *  dedicated Workers. The popup sends bytes to the offscreen via
 *  the SW relay; the offscreen forwards them here. */
export class LsmUploadChunk extends Rpc.make("LsmUploadChunk", {
  payload: {
    path: Schema.String,
    offset: Schema.Number,
    bytes: BytesIn,
    final: Schema.Boolean,
  },
  success: Schema.Void,
  error: BlobStoreError,
}) {}

/** Reopen the lsm-tree session against the OPFS tree that the
 *  upload just populated. Closes any prior session handle. After
 *  this resolves, subsequent BlobStore ops target the restored
 *  session. */
export class LsmReopenAfterUpload extends Rpc.make("LsmReopenAfterUpload", {
  payload: {},
  success: Schema.Void,
  error: BlobStoreError,
}) {}

/** Inspect the OPFS state under the lsm-tree session root. Lets the
 *  popup detect a previously-uploaded snapshot on mount and offer
 *  "resume" UX instead of forcing a re-upload. The fields mirror
 *  the canonical V2LSM on-disk layout:
 *
 *   - `hasSession`     — `/data/lsm/active/` exists (live session)
 *   - `hasSnapshots`   — `/data/lsm/snapshots/` exists + non-empty
 *   - `byteCount`      — total bytes under `/data/lsm/` (popup
 *                        shows this as "X MiB on disk" so the user
 *                        knows resume isn't free of state)
 *   - `lastModifiedMs` — newest mtime under the tree, 0 if empty.
 *                        Surfaces a "snapshot from N minutes ago"
 *                        affordance.
 */
export class LsmInspectOpfs extends Rpc.make("LsmInspectOpfs", {
  payload: {},
  success: Schema.Struct({
    hasSession: Schema.Boolean,
    hasSnapshots: Schema.Boolean,
    byteCount: Schema.Number,
    lastModifiedMs: Schema.Number,
  }),
  error: BlobStoreError,
}) {}

export const LsmRpcGroup = RpcGroup.make(
  LsmGet,
  LsmPut,
  LsmDelete,
  LsmHas,
  LsmScan,
  LsmPutBatch,
  LsmDeleteBatch,
  LsmUploadChunk,
  LsmReopenAfterUpload,
  LsmInspectOpfs,
);
