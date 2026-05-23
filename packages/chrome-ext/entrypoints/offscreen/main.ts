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
import {
  BOOTSTRAP_SETTINGS_STORAGE_KEY,
  type BootstrapSettings,
  loadSettingsFromChromeStorage,
  loadSettingsFromChromeStorageWithRetry,
  readE2eDeferBootstrapFlag,
} from "../shared/bootstrap-settings.ts";
import { appendSessionLogLine, TestLogBufferLayer } from "../shared/test-log-buffer.ts";

/** Holds the currently-running bootstrap-sync fiber so the
 *  `RequestRestart` RPC can interrupt and re-fork it. Populated by
 *  `program` below before the RPC server starts handling requests. */
const bootstrapFiberRef = Ref.makeUnsafe<
  Fiber.Fiber<void, unknown> | undefined
>(undefined);

type UploadChunkGate = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
};

/** Join duplicate `UploadSnapshotChunk` dispatches for the same path+offset.
 *  Must register synchronously (no `yield*` before `set`) — see
 *  `gateUploadChunk` below. */
const uploadChunkGates = new Map<string, UploadChunkGate>();

/** Returns `{ leader: true }` for the fiber that runs the worker RPC; joiners
 *  await the same `promise`. Called synchronously at handler entry. */
const gateUploadChunk = (
  key: string,
): { readonly leader: boolean; readonly promise: Promise<void> } => {
  const existing = uploadChunkGates.get(key);
  if (existing !== undefined) {
    return { leader: false, promise: existing.promise };
  }
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const entry: UploadChunkGate = { promise, resolve, reject };
  uploadChunkGates.set(key, entry);
  return { leader: true, promise: entry.promise };
};

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
/** lsm-worker only — provided per upload/reopen handler, not on RpcServer
 *  `Layer.launch`, so `Ping` is not blocked behind WASM/worker transport init. */
const lsmLayer = LsmWorkerBrowser.pipe(Layer.orDie);

/** Consensus + ChainDB stack — forked after the OffscreenRpc server so
 *  popup→SW→offscreen uploads are not lost on BroadcastChannel while this
 *  layer builds (BC requests are not replayed). */
const runtimeHeavy = browserStorageDerivedLayers.pipe(
  Layer.provideMerge(lsmLayer),
  Layer.merge(browserLayersWithoutBlobStore),
  Layer.merge(ChromeLocalKeyValueStoreLayer),
);

// ---------------------------------------------------------------------------
// Offscreen RPC server
// ---------------------------------------------------------------------------

const OffscreenRpcHandlers = OffscreenRpcs.toLayer(
  Effect.gen(function* () {
    const broadcast = yield* OffscreenAtomBroadcast;
    // Do NOT `yield* LsmRpcClient` here — that blocks RpcServer registration
    // until the worker transport is wired. Popup upload step 2.5 uses `Ping`
    // (no worker) to confirm the SW→offscreen BC relay; eager acquisition
    // left uploads timing out at 90s while WASM/transport initialized.
    return OffscreenRpcs.of({
      // `Clock` is the Effect-canonical wallclock read; the SW-side
      // ping client compares against its own `Date.now()` to log
      // cross-process skew at boot.
      Ping: () =>
        Clock.currentTimeMillis.pipe(
          Effect.tap((timeMs) =>
            Effect.logInfo(`[offscreen-handler] Ping ok (timeMs=${timeMs})`),
          ),
          Effect.map((timeMs) => ({ ok: true, timeMs: Number(timeMs) })),
        ),
      // Real restart semantics: interrupt the currently-running
      // bootstrap-sync fiber (if any) and fork a fresh one. The
      // popup calls this after `ReopenAfterSnapshot` so the
      // newly-uploaded OPFS ledger-state gets re-read by the
      // pipeline's `readLedgerStateFromOpfs` step. Idempotent
      // under repeated invocations — the second-after-the-first
      // restart sees the prior fiber already torn down.
      RequestRestart: ({ settings: relayed }) =>
        Effect.gen(function* () {
          appendSessionLogLine("[offscreen-handler] RequestRestart ENTER");
          yield* forkBootstrapSync(relayed);
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
        Effect.gen(function* () {
          const lsm = yield* LsmRpcClient;
          const chunkKey = `${path}:${offset}`;
          const { leader, promise } = gateUploadChunk(chunkKey);
          if (!leader) {
            yield* Effect.logInfo(
              `[offscreen-handler] UploadSnapshotChunk join path=${path} offset=${offset}`,
            );
            yield* Effect.promise(() => promise);
            return;
          }
          const entry = uploadChunkGates.get(chunkKey);
          yield* Effect.logInfo(
            `[offscreen-handler] UploadSnapshotChunk ENTER path=${path} offset=${offset} bytes=${bytes.length} final=${final}`,
          ).pipe(
            Effect.andThen(lsm.LsmUploadChunk({ path, offset, bytes, final })),
            Effect.tap(() =>
              Effect.logInfo(`[offscreen-handler] UploadSnapshotChunk DONE path=${path}`),
            ),
            Effect.tap(() => Effect.sync(() => entry?.resolve())),
            Effect.tapCause((cause) =>
              Effect.sync(() => {
                entry?.reject(cause);
              }),
            ),
            Effect.ensuring(Effect.sync(() => uploadChunkGates.delete(chunkKey))),
            Effect.orDie,
          );
        }),
      ReopenAfterSnapshot: () =>
        Effect.gen(function* () {
          const lsm = yield* LsmRpcClient;
          yield* Effect.logInfo("[offscreen-handler] ReopenAfterSnapshot");
          yield* lsm.LsmReopenAfterUpload({}).pipe(Effect.orDie);
        }),
      // Popup-on-mount probe — relays the worker's OPFS inspection so
      // the popup can offer "resume existing snapshot" without
      // forcing a re-upload. The worker walks the OPFS tree
      // asynchronously (no sync access handles); safe to call
      // concurrently with in-flight session ops.
      InspectOpfsSnapshot: () =>
        Effect.gen(function* () {
          const lsm = yield* LsmRpcClient;
          return yield* lsm.LsmInspectOpfs({}).pipe(Effect.orDie);
        }),
    });
  }),
);

/** Popup → SW → offscreen RPC. Started at module load (mirrors `lsm-worker.ts`)
 *  so the BroadcastChannel listener exists before `program` forks bootstrap —
 *  `Effect.forkScoped(Layer.launch(...))` previously returned before the server
 *  registered, so `InspectOpfs` / upload probes hit a 90s `TimeoutError`. */
const OffscreenRpcHandlersLive = OffscreenRpcHandlers.pipe(
  Layer.provide(ChromeLocalKeyValueStoreLayer),
  Layer.provideMerge(lsmLayer),
);

const OffscreenRpcServerLive = RpcServer.layer(OffscreenRpcs, {
  // Mirrors the SW `RpcServerLive` — defects don't crash the daemon;
  // the offscreen lifetime is tied to the document, not a single RPC
  // call's failure mode.
  disableFatalDefects: true,
}).pipe(
  Layer.provide(OffscreenRpcHandlersLive),
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

appendSessionLogLine("[offscreen] main.ts module loaded");

Effect.runFork(
  Layer.launch(OffscreenRpcServerLive).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        appendSessionLogLine(
          "[offscreen] OffscreenRpcs server listening (gerolamino/offscreen-rpc)",
        ),
      ),
    ),
    Effect.provide(TestLogBufferLayer),
  ),
);

// Do NOT fork a second `Effect.provide(lsmLayer)` pre-warm here — a second
// `LsmRpcClient` registers another worker `backing.run` demux and corrupts
// `ReopenAfterSnapshot` responses (`BlobStoreError: at decode`). The RpcServer
// layer above already `provideMerge(lsmLayer)`; the worker boots on first upload.

// ---------------------------------------------------------------------------
// Boot — compose both effects under the shared `runtimeLayer` so the
// Worker is spawned exactly once and shared between consumers.
// ---------------------------------------------------------------------------

/** Subscribe to the lsm-worker's BroadcastChannel log relay so the
 *  Worker's diagnostic logs land in the offscreen page's console (and
 *  by extension Playwright's `page.on("console", ...)` capture). The
 *  Worker is spawned via Vite `?worker` import, so Web Workers spawned
 *  there don't get their `console.log` propagated to the parent —
 *  hence the dedicated channel. See `workers/lsm-worker.ts:lsmLog`.
 *
 *  Subscribed at MODULE LOAD (before `runtimeLayer` evaluates) so the
 *  Worker's first log lines — including its module-load entry — land
 *  in the listener queue. If subscription deferred into `program`,
 *  layer construction (which spawns the Worker) outraces the listener. */
{
  const channel = new BroadcastChannel("gerolamino/lsm-worker-log");
  channel.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      Effect.runFork(Effect.logInfo(`[lsm-worker] ${event.data}`));
    }
  });
}

/** Fork bootstrap-sync once settings exist. `forkDetach` so storage listeners
 *  and `RequestRestart` are not tied to the outer `program` scope.
 *
 *  `ChromeLocalKeyValueStoreLayer` is provided here (not only on `program`)
 *  so `RequestRestart` and the storage watcher can read persisted settings
 *  even when the RpcServer handler scope does not inherit the boot layer. */
const forkBootstrapSync = (relayed?: BootstrapSettings) =>
  Effect.gen(function* () {
    const prior = yield* Ref.get(bootstrapFiberRef);
    if (prior !== undefined) {
      yield* Effect.logInfo("[offscreen] Interrupting prior bootstrap-sync fiber before restart");
      yield* Fiber.interrupt(prior);
      yield* Ref.set(bootstrapFiberRef, undefined);
    }
    const settings =
      relayed ??
      (yield* loadSettingsFromChromeStorageWithRetry(10, 100));
    if (settings === undefined) {
      const skipLine = "[offscreen] forkBootstrapSync skipped — no persisted settings";
      appendSessionLogLine(skipLine);
      yield* Effect.logInfo(skipLine);
      return;
    }
    const forkLine = `[offscreen] Forking bootstrap-sync (mode=${settings.mode})`;
    appendSessionLogLine(forkLine);
    yield* Effect.logInfo(forkLine);
    const fiber = yield* Effect.forkDetach(
      Effect.scoped(
        bootstrapSyncWithStateUpdates(settings).pipe(
          Effect.provide(runtimeHeavy),
          Effect.provide(TestLogBufferLayer),
          Effect.tapError((err) =>
            Effect.logWarning(`[offscreen] bootstrap-sync fiber failed: ${String(err)}`).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  appendSessionLogLine(`[offscreen] bootstrap-sync fiber failed: ${String(err)}`),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    yield* Ref.set(bootstrapFiberRef, fiber);
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Fiber.join(fiber).pipe(Effect.ignore);
        const current = yield* Ref.get(bootstrapFiberRef);
        if (current === fiber) {
          yield* Ref.set(bootstrapFiberRef, undefined);
        }
      }).pipe(Effect.orDie),
    );
  });

const registerBootstrapSettingsWatcher = Effect.sync(() => {
  appendSessionLogLine("[offscreen] bootstrap settings watcher registered");
  globalThis.chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const change = changes[BOOTSTRAP_SETTINGS_STORAGE_KEY];
    if (change === undefined || change.newValue === undefined) return;
    Effect.runFork(
      Effect.gen(function* () {
        // Upload/restart paths call `RequestRestart` explicitly after
        // `saveSettings`. Forking here while `ReopenAfterSnapshot` still
        // holds the lsm-worker races genesis WASM on the single worker.
        if (yield* readE2eDeferBootstrapFlag) {
          appendSessionLogLine(
            "[offscreen] bootstrap settings changed — skipped fork (e2e defer; RequestRestart owns bootstrap)",
          );
          return;
        }
        appendSessionLogLine("[offscreen] bootstrap settings changed — forking bootstrap-sync");
        yield* Effect.logInfo("[offscreen] bootstrap settings changed — forking bootstrap-sync");
        yield* forkBootstrapSync(undefined);
      }).pipe(Effect.orDie),
    );
  });
});

const program = Effect.gen(function* () {
  yield* Effect.logInfo("[offscreen] Offscreen daemon booting");
  yield* Effect.logInfo(
    "[offscreen] OffscreenRpcs server started at module load (Ping/upload ready)",
  );
  // Do NOT `Layer.launch(runtimeHeavy)` here — ChainDB's boot-time BlobStore
  // seed would contend with the lsm-worker while genesis `StartSync` is also
  // building `runtimeHeavy`, leaving bootstrap stuck at "Initializing WASM"
  // with no atom deltas. `runtimeHeavy` is provided only when bootstrap-sync
  // forks (auto-start below, storage watcher, or `RequestRestart` from popup).
  // Defer bootstrap when:
  //   - E2E `?deferBootstrapSync=1` (upload specs keep the worker exclusive), or
  //   - No persisted settings yet (first-open upload must not race ChainDB on
  //     the single lsm-worker before `mode:local` is saved + StartSync fires).
  // Returning users with saved settings fork bootstrap immediately.
  const deferQuery = new URLSearchParams(globalThis.location.search).has(
    "deferBootstrapSync",
  );
  const sessionDefer = yield* readE2eDeferBootstrapFlag;
  const persisted = yield* loadSettingsFromChromeStorage;
  const deferBootstrap = deferQuery || sessionDefer || persisted === undefined;
  if (!deferBootstrap) {
    yield* forkBootstrapSync(undefined);
  } else {
    yield* Effect.logInfo(
      deferQuery
        ? "[offscreen] bootstrap-sync deferred (deferBootstrapSync=1) — StartSync will fork"
        : sessionDefer
          ? "[offscreen] bootstrap-sync deferred (e2e session flag) — StartSync after setup"
          : "[offscreen] bootstrap-sync deferred (no persisted settings) — StartSync after setup",
    );
    // E2E defer must stay exclusive until upload/restart — never fork from a
    // stale `chrome.storage.local` read left by a prior serial Playwright spec.
    if (sessionDefer || deferQuery) {
      yield* registerBootstrapSettingsWatcher;
    } else {
      // First-open race: SW boots offscreen before the popup seeds settings.
      const late = yield* loadSettingsFromChromeStorageWithRetry(10);
      if (late !== undefined) {
        yield* forkBootstrapSync(late);
      } else {
        yield* registerBootstrapSettingsWatcher;
      }
    }
  }
  // Block forever inside the scope so runtimeLayer's resources stay
  // alive. Offscreen document lifetime is bounded by Chromium, not
  // by us — when Chromium evicts the offscreen, the runtime tears
  // down everything and this fiber dies naturally.
  yield* Effect.never;
});

program.pipe(
  Effect.scoped,
  Effect.provide(lsmLayer),
  Effect.provide(ChromeLocalKeyValueStoreLayer),
  Effect.provide(TestLogBufferLayer),
  Effect.runFork,
);
