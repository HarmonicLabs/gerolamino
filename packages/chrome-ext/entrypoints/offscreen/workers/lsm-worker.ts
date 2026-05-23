/**
 * Browser-Worker entrypoint for the BlobStore RPC server.
 *
 * Spawned from `../lsm-pool.ts` via `new Worker(new URL(...))`. The
 * worker boots:
 *
 *   1. A WASI host (`@bjorn3/browser_wasi_shim` v0.4.2) with OPFS as
 *      the preopen filesystem. `FileSystemSyncAccessHandle` is
 *      dedicated-Worker-only — that constraint is the entire reason
 *      this code lives in a Worker rather than in the offscreen
 *      document.
 *   2. The lsm-tree WASM reactor (`loadLsmModule` from `lsm-ffi`),
 *      which uses the WASI imports table to satisfy `unix`-syscall-
 *      shaped Haskell calls.
 *   3. An `RpcServer` over `BrowserWorkerRunner` that handles
 *      `LsmRpcGroup` methods by forwarding to the loaded
 *      `LsmModule`'s typed ops.
 *
 * OPFS I/O goes through Effect `FileSystem` (`OpfsFileSystem.layer`);
 * WASI preopen is built separately for the Haskell runtime only.
 */
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { Effect, Layer, Option, Ref } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { type PreopenDirectory, WASI } from "@bjorn3/browser_wasi_shim";
import { layer as OpfsFileSystemLayer, writeOpfsFileSlice } from "../../../src/opfs/file-system.ts";
import { buildWasiPreopen } from "../../../src/opfs/wasi-preopen.ts";
import { inspectOpfsLsm } from "../../../src/opfs/inspect.ts";
import {
  BlobStoreError,
  loadLsmModule,
  type LsmModule,
  type WasiAdapter,
} from "lsm-ffi";
import { LsmWasmError } from "wasm-utils/lsm/wasm/errors.ts";
import { lsmTreeJsffiUrl, lsmTreeWasmUrl } from "wasm-utils/lsm-shim/urls.ts";
import { WasmBytes, WasmBytesUrlLayer } from "wasm-utils/loader.ts";
import { LsmRpcGroup } from "../lsm-rpc.ts";

const wasmUrl = lsmTreeWasmUrl;
const jsffiUrl = lsmTreeJsffiUrl;

const LSM_WORKER_LOG_CHANNEL = "gerolamino/lsm-worker-log";
const LSM_WORKER_CONTROL_CHANNEL = "gerolamino/lsm-worker-control";
const logChannel = new BroadcastChannel(LSM_WORKER_LOG_CHANNEL);
const workerStartMs = Date.now();
const lsmLog = (message: string): void => {
  const t = (Date.now() - workerStartMs).toString().padStart(5, " ");
  logChannel.postMessage(`+${t}ms ${message}`);
};

lsmLog(`module loaded (startMs=${workerStartMs}, channel=${LSM_WORKER_LOG_CHANNEL})`);

const controlChannel = new BroadcastChannel(LSM_WORKER_CONTROL_CHANNEL);
controlChannel.onmessage = (event: MessageEvent) => {
  if (event.data === "terminate") {
    lsmLog("control: terminate — closing worker");
    self.close();
  }
};

const SESSION_MOUNT = "/data";
const LSM_SESSION_SUBDIR = "lsm";

const makeWasiAdapterFromPreopen = (preopen: PreopenDirectory): WasiAdapter => {
  const wasi = new WASI([], [], [preopen]);
  return {
    wasiImport: wasi.wasiImport,
    initialize: (instance) => {
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) {
        throw new BlobStoreError({
          operation: "lsm",
          cause: "lsm-worker: WASM module missing required `memory` export",
        });
      }
      const initRaw = instance.exports._initialize;
      const _initialize =
        typeof initRaw === "function"
          ? (): unknown => Reflect.apply(initRaw, undefined, [])
          : undefined;
      wasi.initialize({ exports: { memory, _initialize } });
    },
  };
};

type JsffiFactory = (exports: Record<string, unknown>) => WebAssembly.ModuleImports;

interface WorkerState {
  readonly wasmBytes: Uint8Array;
  readonly jsffiFactory: JsffiFactory;
  readonly lsmRef: Ref.Ref<LsmModule | undefined>;
  readonly sessionHandle: Ref.Ref<number | undefined>;
  readonly tableHandle: Ref.Ref<number | undefined>;
}

const mapLoadLsmError = (e: LsmWasmError) =>
  new BlobStoreError({ operation: "lsm", cause: e });

const makeWorkerState = Effect.gen(function* () {
  const wasm = yield* WasmBytes;
  const wasmBytes = yield* wasm.load("lsm-tree").pipe(
    Effect.mapError((cause) => new BlobStoreError({ operation: "lsm", cause })),
  );
  const jsffiFactory = yield* Effect.tryPromise({
    try: async () => {
      const m = await import(jsffiUrl.href);
      return m.default;
    },
    catch: (cause) => new BlobStoreError({ operation: "lsm", cause }),
  });
  const wasmBytesAB = new Uint8Array(wasmBytes);
  const lsmRef = yield* Ref.make<LsmModule | undefined>(undefined);
  const sessionHandle = yield* Ref.make<number | undefined>(undefined);
  const tableHandle = yield* Ref.make<number | undefined>(undefined);
  return { wasmBytes: wasmBytesAB, jsffiFactory, lsmRef, sessionHandle, tableHandle };
});

const copyBytes = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes);

const formatLsmCause = (cause: unknown): unknown =>
  cause instanceof LsmWasmError
    ? `${cause.operation}: ${String(cause.cause)}`
    : cause;

const wrapBlobError = (cause: unknown) =>
  new BlobStoreError({ operation: "lsm", cause: formatLsmCause(cause) });

const closeOpenSession = (state: WorkerState): Effect.Effect<void, BlobStoreError> =>
  Effect.gen(function* () {
    const lsm = yield* Ref.get(state.lsmRef);
    if (lsm === undefined) return;
    const table = yield* Ref.get(state.tableHandle);
    const session = yield* Ref.get(state.sessionHandle);
    if (table !== undefined) {
      yield* lsm.closeTable(table).pipe(Effect.mapError(wrapBlobError), Effect.ignore);
    }
    if (session !== undefined) {
      yield* lsm.closeSession(session).pipe(Effect.mapError(wrapBlobError), Effect.ignore);
    }
    yield* Ref.set(state.tableHandle, undefined);
    yield* Ref.set(state.sessionHandle, undefined);
  });

const loadLsmAgainstPreopen = (
  state: WorkerState,
  preopen: PreopenDirectory,
): Effect.Effect<LsmModule, BlobStoreError> =>
  Effect.gen(function* () {
    const wasi = makeWasiAdapterFromPreopen(preopen);
    const lsm = yield* loadLsmModule({
      wasmBytes: state.wasmBytes,
      jsffiFactory: state.jsffiFactory,
      wasi,
    }).pipe(Effect.mapError(mapLoadLsmError));
    yield* Ref.set(state.lsmRef, lsm);
    return lsm;
  });

const openLsmSession = (
  state: WorkerState,
  preopen: PreopenDirectory,
): Effect.Effect<number, BlobStoreError> =>
  Effect.gen(function* () {
    yield* closeOpenSession(state);
    yield* Ref.set(state.lsmRef, undefined);
    const lsm = yield* loadLsmAgainstPreopen(state, preopen);
    const sessionDir = `${SESSION_MOUNT}/${LSM_SESSION_SUBDIR}`;
    const smokeRc = yield* lsm.smoke(sessionDir).pipe(Effect.mapError(wrapBlobError));
    lsmLog(`lsm-tree smoke("${sessionDir}") rc=${smokeRc}`);
    if (smokeRc !== 0) {
      return yield* Effect.fail(
        new BlobStoreError({
          operation: "lsm",
          cause: `lsm-tree smoke failed with rc=${smokeRc}`,
        }),
      );
    }
    const session = yield* lsm.openSession(sessionDir).pipe(Effect.mapError(wrapBlobError));
    const table = yield* lsm.openTable(session, "default").pipe(Effect.mapError(wrapBlobError));
    yield* Ref.set(state.sessionHandle, session);
    yield* Ref.set(state.tableHandle, table);
    return table;
  });

type LsmHandlerR = import("effect/FileSystem").FileSystem | WasmBytes;

const requireTable = (
  state: WorkerState,
): Effect.Effect<number, BlobStoreError, import("effect/FileSystem").FileSystem> =>
  Effect.gen(function* () {
    const existing = yield* Ref.get(state.tableHandle);
    if (existing !== undefined) return existing;
    const { preopen, filesMounted } = yield* buildWasiPreopen(
      SESSION_MOUNT,
      LSM_SESSION_SUBDIR,
      4096,
    ).pipe(Effect.mapError(wrapBlobError));
    lsmLog(`WASI preopen ready (${filesMounted} lazy file inode(s) under /data/lsm)`);
    const table = yield* openLsmSession(state, preopen);
    lsmLog("opened lsm-tree session (OPFS-backed WASI)");
    return table;
  });

const withLoadedLsm = <A>(
  state: WorkerState,
  use: (lsm: LsmModule) => Effect.Effect<A, BlobStoreError>,
): Effect.Effect<A, BlobStoreError> =>
  Effect.gen(function* () {
    const lsm = yield* Ref.get(state.lsmRef);
    if (lsm === undefined) {
      return yield* Effect.fail(
        new BlobStoreError({ operation: "lsm", cause: "lsm-tree module not loaded yet" }),
      );
    }
    return yield* use(lsm);
  });

const putBatchEntries = (
  lsm: LsmModule,
  table: number,
  entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>,
): Effect.Effect<void, BlobStoreError> => {
  if (entries.length === 0) return Effect.void;
  return Effect.gen(function* () {
    for (const { key, value } of entries) {
      yield* lsm
        .put(table, copyBytes(key), copyBytes(value))
        .pipe(Effect.mapError(wrapBlobError));
    }
  });
};

const withTable = (
  ensureState: () => Effect.Effect<WorkerState, BlobStoreError, WasmBytes>,
  use: (state: WorkerState, table: number) => Effect.Effect<void, BlobStoreError>,
): Effect.Effect<void, BlobStoreError, LsmHandlerR> =>
  Effect.gen(function* () {
    const state = yield* ensureState();
    const table = yield* requireTable(state);
    yield* use(state, table);
  });

const makeHandlers = (
  ensureState: () => Effect.Effect<WorkerState, BlobStoreError, WasmBytes>,
) => ({
  LsmGet: ({ key }: { readonly key: Uint8Array }) =>
    ensureState().pipe(
      Effect.flatMap((state) =>
        requireTable(state).pipe(
          Effect.flatMap((h) =>
            withLoadedLsm(state, (lsm) =>
              lsm.get(h, copyBytes(key)).pipe(Effect.mapError(wrapBlobError)),
            ),
          ),
          Effect.map((opt) => Option.getOrNull(opt)),
        ),
      ),
    ),

  LsmPut: ({ key, value }: { readonly key: Uint8Array; readonly value: Uint8Array }) =>
    withTable(ensureState, (state, h) =>
      withLoadedLsm(state, (lsm) =>
        lsm.put(h, copyBytes(key), copyBytes(value)).pipe(Effect.mapError(wrapBlobError)),
      ),
    ),

  LsmDelete: ({ key }: { readonly key: Uint8Array }) =>
    withTable(ensureState, (state, h) =>
      withLoadedLsm(state, (lsm) =>
        lsm.delete(h, copyBytes(key)).pipe(Effect.mapError(wrapBlobError)),
      ),
    ),

  LsmHas: ({ key }: { readonly key: Uint8Array }) =>
    ensureState().pipe(
      Effect.flatMap((state) =>
        requireTable(state).pipe(
          Effect.flatMap((h) =>
            withLoadedLsm(state, (lsm) =>
              lsm.has(h, copyBytes(key)).pipe(Effect.mapError(wrapBlobError)),
            ),
          ),
        ),
      ),
    ),

  LsmScan: ({ prefix }: { readonly prefix: Uint8Array }) =>
    ensureState().pipe(
      Effect.flatMap((state) =>
        requireTable(state).pipe(
          Effect.flatMap((tableH) =>
            withLoadedLsm(state, (lsm) =>
              Effect.gen(function* () {
                const cursor = yield* lsm.cursorOpen(tableH, copyBytes(prefix)).pipe(
                  Effect.mapError(wrapBlobError),
                );
                try {
                  const collected: Array<{ readonly key: Uint8Array; readonly value: Uint8Array }> =
                    [];
                  let done = false;
                  while (!done) {
                    const batch = yield* lsm.cursorRead(cursor, 256).pipe(
                      Effect.mapError(wrapBlobError),
                    );
                    if (batch.entries.length === 0) {
                      done = true;
                      break;
                    }
                    for (const e of batch.entries) collected.push(e);
                  }
                  return collected;
                } finally {
                  yield* lsm.cursorClose(cursor).pipe(Effect.mapError(wrapBlobError), Effect.ignore);
                }
              }),
            ),
          ),
        ),
      ),
      Effect.mapError(wrapBlobError),
    ),

  LsmPutBatch: ({
    entries,
  }: {
    readonly entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>;
  }) =>
    withTable(ensureState, (state, h) => withLoadedLsm(state, (lsm) => putBatchEntries(lsm, h, entries))),

  LsmDeleteBatch: ({ keys }: { readonly keys: ReadonlyArray<Uint8Array> }) =>
    withTable(ensureState, (state, h) =>
      withLoadedLsm(state, (lsm) =>
        lsm.deleteBatch(h, keys.map(copyBytes)).pipe(Effect.mapError(wrapBlobError)),
      ),
    ),

  LsmUploadChunk: (params: {
    readonly path: string;
    readonly offset: number;
    readonly bytes: Uint8Array;
    readonly final: boolean;
  }) =>
    writeOpfsFileSlice(
      params.path,
      params.offset,
      copyBytes(params.bytes),
      params.final,
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          lsmLog(
            `LsmUploadChunk path=${params.path} offset=${params.offset} bytes=${params.bytes.length} final=${params.final}`,
          ),
        ),
      ),
      Effect.mapError(wrapBlobError),
    ),

  LsmReopenAfterUpload: () =>
    ensureState().pipe(
      Effect.flatMap((state) =>
        buildWasiPreopen(SESSION_MOUNT, LSM_SESSION_SUBDIR, 4096).pipe(
          Effect.mapError(wrapBlobError),
          Effect.flatMap(({ preopen, filesMounted }) => {
            lsmLog(`LsmReopenAfterUpload: WASI preopen (${filesMounted} file inode(s))`);
            return openLsmSession(state, preopen).pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  lsmLog("LsmReopenAfterUpload: session opened against native OPFS lsm/"),
                ),
              ),
            );
          }),
          Effect.asVoid,
        ),
      ),
    ),

  LsmInspectOpfs: () => inspectOpfsLsm.pipe(Effect.mapError(wrapBlobError)),
});

const HandlersLive = LsmRpcGroup.toLayer(
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<WorkerState | undefined>(undefined);
    const stateInitRef = yield* Ref.make(makeWorkerState);
    const ensureState = () =>
      Effect.gen(function* () {
        const cached = yield* Ref.get(stateRef);
        if (cached !== undefined) return cached;
        const ticket = yield* Ref.modify(stateInitRef, (prior) => {
          const chained = prior.pipe(Effect.tap((s) => Ref.set(stateRef, s)));
          return [chained, chained] as const;
        });
        return yield* ticket;
      });
    lsmLog("HandlersLive registered — LsmUploadChunk ready (WASM loads on first table op)");
    return LsmRpcGroup.of(makeHandlers(ensureState));
  }),
);

const WorkerLive = RpcServer.layer(LsmRpcGroup).pipe(
  Layer.provide(HandlersLive),
  Layer.provide(OpfsFileSystemLayer),
  Layer.provide(WasmBytesUrlLayer({ "lsm-tree": wasmUrl })),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer),
);

Effect.runFork(Layer.launch(WorkerLive));
