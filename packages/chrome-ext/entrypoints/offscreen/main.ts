/**
 * Offscreen daemon entrypoint — the persistent compute process for the
 * chrome-ext Cardano node.
 *
 * The offscreen hosts:
 *   1. The Effect runtime with the offscreen-local atom registry
 *      + 100 ms broadcast fiber (`./atoms.ts` + `./broadcast.ts`).
 *   2. The OffscreenRpcs server (`Ping` / `RequestRestart` /
 *      `SubscribeAtomDeltas` / `UploadSnapshotChunk` /
 *      `ReopenAfterSnapshot`) over the typed BroadcastChannel
 *      transport.
 *   3. The bootstrap-sync pipeline that owns the WebSocket + the
 *      consensus driver. Atoms get written from inside this process;
 *      `SubscribeAtomDeltas` streams JSON deltas to the SW which
 *      relays each popup connection.
 *   4. A single dedicated `lsm-worker` (spawned by `lsm-pool.ts`)
 *      hosting `@bjorn3/browser_wasi_shim` + lsm-tree WASM + OPFS
 *      sync handles. Both the bootstrap-sync `BlobStore` and the
 *      OffscreenRpcs upload handlers share the same Worker via the
 *      `runtimeLayer` composition below — Effect Layer memoization
 *      keeps it to one `new Worker(...)` call.
 *
 * The offscreen runs under the `WORKERS` reason (Chrome 124+) for
 * indefinite lifetime — survives SW eviction independently.
 */
import { Clock, Effect, Fiber, Layer, Ref, Stream } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { buildDeltaJson } from "dashboard/delta";
import { registry } from "./atoms.ts";
import {
  bootstrapSyncWithStateUpdates,
  browserLayersWithoutBlobStore,
  browserStorageDerivedLayers,
} from "./bootstrap-sync.ts";
import { OffscreenAtomBroadcast } from "./broadcast.ts";
import { LsmRpcClient, LsmWorkerBrowser } from "./lsm-pool.ts";
import { OffscreenRpcs } from "./rpc.ts";
import { layerServerProtocolBroadcastChannel } from "./rpc-transport.ts";
import { ChromeLocalKeyValueStoreLayer } from "../shared/chrome-key-value-store.ts";
import { TestLogBufferLayer } from "../shared/test-log-buffer.ts";

/** Holds the currently-running bootstrap-sync fiber so the
 *  `RequestRestart` RPC can interrupt and re-fork it. Populated by
 *  `program` below before the RPC server starts handling requests. */
const bootstrapFiberRef = Ref.makeUnsafe<
  Fiber.Fiber<void, unknown> | undefined
>(undefined);

// ---------------------------------------------------------------------------
// Shared runtime layer.
//
// `LsmWorkerBrowser` provides BOTH `BlobStore` (consumed by ChainDB +
// LedgerSnapshotStore + bootstrap-sync) AND `LsmRpcClient` (consumed
// by the snapshot-upload RPC handlers below). One Worker, two
// service tags, one composition site → Layer memoization keeps it
// to a single `new Worker(...)` call.
// ---------------------------------------------------------------------------

// `Layer.provideMerge`: provide `LsmWorkerBrowser` (BlobStore +
// LsmRpcClient) to `browserStorageDerivedLayers` (ChainDB +
// LedgerSnapshotStore) AND keep BlobStore + LsmRpcClient exposed in
// the result. The chained pipe then `Layer.merge`s with
// `browserLayersWithoutBlobStore` for the remaining infrastructure
// (Socket, Crypto, ChainEvents, ConsensusEvents, SlotClock,
// PeerManager). Single composition site → single Worker spawn.
const runtimeLayer = browserStorageDerivedLayers.pipe(
  Layer.provideMerge(LsmWorkerBrowser.pipe(Layer.orDie)),
  Layer.merge(browserLayersWithoutBlobStore),
  Layer.merge(ChromeLocalKeyValueStoreLayer),
);

// ---------------------------------------------------------------------------
// Offscreen RPC server
// ---------------------------------------------------------------------------

const OffscreenRpcHandlers = OffscreenRpcs.toLayer(
  Effect.gen(function* () {
    const broadcast = yield* OffscreenAtomBroadcast;
    const lsm = yield* LsmRpcClient;
    return OffscreenRpcs.of({
      // `Clock` is the Effect-canonical wallclock read; the SW-side
      // ping client compares against its own `Date.now()` to log
      // cross-process skew at boot.
      Ping: () =>
        Clock.currentTimeMillis.pipe(
          Effect.map((timeMs) => ({ ok: true, timeMs: Number(timeMs) })),
        ),
      // Real restart semantics: interrupt the currently-running
      // bootstrap-sync fiber (if any) and fork a fresh one. The
      // popup calls this after `ReopenAfterSnapshot` so the
      // newly-uploaded OPFS ledger-state gets re-read by the
      // pipeline's `readLedgerStateFromOpfs` step. Idempotent
      // under repeated invocations — the second-after-the-first
      // restart sees the prior fiber already torn down.
      RequestRestart: () =>
        Effect.gen(function* () {
          const prior = yield* Ref.get(bootstrapFiberRef);
          if (prior !== undefined) {
            yield* Effect.logInfo("[offscreen] RequestRestart — interrupting prior bootstrap-sync fiber");
            yield* Fiber.interrupt(prior);
          }
          const fiber = yield* Effect.forkDetach(bootstrapSyncWithStateUpdates);
          yield* Ref.set(bootstrapFiberRef, fiber);
          const requestId = `restart-${Date.now()}`;
          yield* Effect.logInfo(`[offscreen] RequestRestart — forked new bootstrap-sync (${requestId})`);
          return { alreadyRunning: false, requestId };
        }),
      // Streams JSON deltas from the offscreen-local broadcast PubSub
      // (fed by the `./broadcast.ts` fiber). Per-popup subscribers
      // attach via the SW's `BroadcastDeltas` relay handler.
      //
      // Cold-popup gap fix: a popup that opens mid-sync would otherwise
      // wait up to `DELTA_PUSH_INTERVAL_MS` (100 ms) before seeing any
      // state, because the PubSub only emits ON state CHANGE.
      // `Stream.concat` prepends an initial snapshot built from the
      // current registry value — the popup-side `applyDelta` doesn't
      // distinguish "initial" from "delta" (deltas ARE full snapshots
      // per `buildDeltaJson`'s contract: line 109 of dashboard/delta.ts).
      // First subscriber render gets accurate state immediately;
      // subsequent ticks dedup against the PubSub's own identity gate.
      SubscribeAtomDeltas: () =>
        Stream.concat(Stream.succeed(buildDeltaJson(registry)), Stream.fromPubSub(broadcast)),
      // Snapshot-upload relay: forward bytes to the lsm-worker
      // (which holds the `FileSystemSyncAccessHandle` per OPFS
      // path). Errors from the worker bubble up as defects — the
      // popup-side caller surfaces them as upload failures in the
      // drag-drop UI. The `logInfo` confirms RPC dispatch reached
      // this handler — the May-2026 release loop's "hangs at file 1/3"
      // diagnostic in `upload-synthetic.spec.ts` is gated on this line.
      UploadSnapshotChunk: ({ path, offset, bytes, final }) =>
        Effect.logInfo(
          `[offscreen-handler] UploadSnapshotChunk path=${path} offset=${offset} bytes=${bytes.length} final=${final}`,
        ).pipe(Effect.andThen(lsm.LsmUploadChunk({ path, offset, bytes, final })), Effect.orDie),
      ReopenAfterSnapshot: () =>
        Effect.logInfo("[offscreen-handler] ReopenAfterSnapshot").pipe(
          Effect.andThen(lsm.LsmReopenAfterUpload({})),
          Effect.orDie,
        ),
      // Popup-on-mount probe — relays the worker's OPFS inspection so
      // the popup can offer "resume existing snapshot" without
      // forcing a re-upload. The worker walks the OPFS tree
      // asynchronously (no sync access handles); safe to call
      // concurrently with in-flight session ops.
      InspectOpfsSnapshot: () => lsm.LsmInspectOpfs({}).pipe(Effect.orDie),
    });
  }),
);

const OffscreenRpcServerLive = RpcServer.layer(OffscreenRpcs, {
  // Mirrors the SW `RpcServerLive` — defects don't crash the daemon;
  // the offscreen lifetime is tied to the document, not a single RPC
  // call's failure mode.
  disableFatalDefects: true,
}).pipe(
  Layer.provide(OffscreenRpcHandlers),
  Layer.provide(layerServerProtocolBroadcastChannel),
  // Effect RPC requires a serialization layer to decode wire envelopes
  // even when the underlying transport is structured-clone (BroadcastChannel
  // here). NDJSON works fine for the request/response envelopes since
  // the heavy payload (Uint8Array snapshot chunks) is carried inside the
  // Schema-encoded data field; only the wire-control fields get JSON
  // round-tripped. Without this layer the RpcServer's `writeRequest`
  // calls fail to dispatch and every handler invocation is silently
  // dropped — the symptom diagnosed in the May-2026 release loop.
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(OffscreenAtomBroadcast.Live),
);

// ---------------------------------------------------------------------------
// Boot — compose both effects under the shared `runtimeLayer` so the
// Worker is spawned exactly once and shared between consumers.
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  yield* Effect.logInfo("[offscreen] Offscreen daemon booting");
  yield* Effect.logInfo("[offscreen] Launching OffscreenRpcs server");
  // `Effect.forkScoped` ties these daemons to `program`'s scope. We
  // DON'T `Effect.scoped` the outer pipe — the scope below stays open
  // for the offscreen document's lifetime via `Effect.never` at the
  // end of program, so the runtimeLayer (BlobStore + LsmRpcClient +
  // ChainDB + Crypto + Socket + BroadcastChannel server listener) all
  // stay live. Phase D's earlier mistake: `Effect.scoped` finalised
  // milliseconds after program's last `yield*`, tearing down the
  // BroadcastChannel listener + lsm-worker right after construction,
  // so every popup → SW → offscreen RPC silently dropped.
  yield* Effect.forkScoped(Layer.launch(OffscreenRpcServerLive));
  yield* Effect.logInfo("[offscreen] Forking bootstrap-sync pipeline");
  const fiber = yield* Effect.forkScoped(bootstrapSyncWithStateUpdates);
  yield* Ref.set(bootstrapFiberRef, fiber);
  // Block forever inside the scope so runtimeLayer's resources stay
  // alive. Offscreen document lifetime is bounded by Chromium, not
  // by us — when Chromium evicts the offscreen, the runtime tears
  // down everything and this fiber dies naturally.
  yield* Effect.never;
});

program.pipe(
  Effect.scoped,
  Effect.provide(runtimeLayer),
  Effect.provide(TestLogBufferLayer),
  Effect.runFork,
);
