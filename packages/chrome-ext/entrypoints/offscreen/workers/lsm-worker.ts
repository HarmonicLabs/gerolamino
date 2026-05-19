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
 * The OPFS root is mounted at `/data` so the lsm-tree session uses
 * `/data/lsm/<session>` paths. The popup's drag-drop uploader streams
 * snapshot bytes to `/data/lsm/` via the `LsmUploadChunk` RPC, then
 * the worker reopens its session against the populated OPFS tree.
 */
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { Effect, Layer, Option, Ref } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import {
  Directory,
  type Inode,
  PreopenDirectory,
  SyncOPFSFile,
  WASI,
} from "@bjorn3/browser_wasi_shim";
import {
  BlobStoreError,
  loadLsmModule,
  type LsmModule,
  type LsmWasmError,
  type WasiAdapter,
} from "lsm-ffi";
// Subpath imports — tsgo's cross-package barrel re-export resolution
// silently drops these names when imported from chrome-ext. The path
// alias `wasm-utils/* → ../wasm-utils/src/*` in tsconfig resolves the
// inner modules; Rolldown handles both forms identically at runtime.
import { lsmTreeJsffiUrl, lsmTreeWasmUrl } from "wasm-utils/lsm-shim/urls.ts";
import { WasmBytes, WasmBytesUrlLayer } from "wasm-utils/loader.ts";
import { LsmRpcGroup } from "../lsm-rpc.ts";

// WASM artifact URLs come from the wasm-utils barrel — see
// `wasm-utils/src/lsm-shim/urls.ts` for the canonical `new URL(...)`
// resolution. Imported via the barrel so the deep path is centralised.
const wasmUrl = lsmTreeWasmUrl;
const jsffiUrl = lsmTreeJsffiUrl;

// ───────────────────────────────────────────────────────────────────
// Log relay. The Worker can't `Effect.log` to its parent offscreen
// page — `BrowserWorkerRunner` owns the postMessage channel for RPC.
// Workers' own `console.log` lands in Chrome DevTools' Web Worker
// inspector but does NOT propagate to Playwright's
// `page.on("console", ...)` listener on the parent.
//
// To get diagnostic visibility (e.g. while debugging the
// `upload-synthetic.spec.ts` hang), broadcast log lines over a
// dedicated `BroadcastChannel`. The offscreen page subscribes via
// `entrypoints/offscreen/main.ts` and forks each message into
// `Effect.logInfo` — Playwright then captures them as offscreen logs.
//
// BroadcastChannel is same-origin pub-sub; the channel name is fixed
// per-worker because there's only one lsm-worker at a time (pool
// `maxSize: 1` invariant).
// ───────────────────────────────────────────────────────────────────

const LSM_WORKER_LOG_CHANNEL = "gerolamino/lsm-worker-log";
const logChannel = new BroadcastChannel(LSM_WORKER_LOG_CHANNEL);
const workerStartMs = Date.now();
const lsmLog = (message: string): void => {
  const t = (Date.now() - workerStartMs).toString().padStart(5, " ");
  const stamped = `+${t}ms ${message}`;
  // Also emit to the Worker's own console for live DevTools inspection.
  console.log(`[lsm-worker] ${stamped}`);
  logChannel.postMessage(stamped);
};

// ───────────────────────────────────────────────────────────────────
// OPFS-backed WASI filesystem.
//
// `@bjorn3/browser_wasi_shim`'s `PreopenDirectory` builds an
// in-memory directory tree where each `File` entry can be backed by
// either `MemoryFile` (default) or `SyncOPFSFile` (persistent). We
// lazily wrap each OPFS file we encounter via `SyncOPFSFile`; the
// in-memory directory tree itself is rebuilt on every worker boot
// from a recursive walk of `navigator.storage.getDirectory()`.
//
// Memory cost: ~16 bytes per directory entry (string + node ref).
// For the lsm-tree session dir (a few thousand files at most),
// this is negligible vs. the bytes the WASM module itself reads.
// ───────────────────────────────────────────────────────────────────

const SESSION_MOUNT = "/data";
const LSM_SESSION_SUBDIR = "lsm";

/** Recursively walk only the `lsm/` subtree of OPFS, building a
 *  Directory tree of `SyncOPFSFile` wrappers. Called once at worker
 *  boot and again after every snapshot upload to refresh the tree.
 *
 *  We restrict the walk to the lsm session subdirectory (instead of
 *  walking OPFS root) because only lsm-tree session files need to be
 *  reachable from the WASI shim — other OPFS files (the popup's
 *  upload sink at root, the snapshot-ingest's `ledger/<slot>/state`,
 *  etc.) are accessed exclusively via the native `FileSystem*Handle`
 *  API from `writeChunk` / `LsmInspectOpfs`. Eagerly opening
 *  `createSyncAccessHandle` for every OPFS file blocks the popup's
 *  subsequent upload writes — Chromium forbids concurrent sync /
 *  writable handles on the same `FileSystemFileHandle`. */
const buildOpfsRoot = async (): Promise<PreopenDirectory> => {
  const root = await navigator.storage.getDirectory();
  const buildDir = async (handle: FileSystemDirectoryHandle): Promise<Directory> => {
    const entries = new Map<string, Inode>();
    // `entries()` is async-iterator-only on FileSystemDirectoryHandle.
    // The unionised `for await...of` is the standard traversal idiom
    // per the OPFS spec.
    for await (const [name, child] of handle.entries()) {
      if (child.kind === "directory") {
        entries.set(name, await buildDir(child));
      } else {
        const sync = await child.createSyncAccessHandle();
        entries.set(name, new SyncOPFSFile(sync));
      }
    }
    return new Directory(entries);
  };
  // Only walk `/lsm/` (if present). If absent — first-boot or
  // upload-pending — fall back to an empty directory; the WASI shim
  // accepts an empty preopen and the lsm-tree session is opened
  // lazily after `LsmReopenAfterUpload`.
  const lsmDir = await root
    .getDirectoryHandle(LSM_SESSION_SUBDIR, { create: false })
    .catch(() => null);
  const treeRoot =
    lsmDir === null
      ? new Directory(new Map<string, Inode>())
      : await buildDir(lsmDir);
  // The preopen presents the lsm tree at `/data/lsm` (matching where
  // `LsmReopenAfterUpload` calls `openSession(`${SESSION_MOUNT}/${LSM_SESSION_SUBDIR}`)`),
  // so the inner contents are wrapped in a `lsm` entry rather than
  // exposed directly under the preopen root.
  const entries = new Map<string, Inode>();
  entries.set(LSM_SESSION_SUBDIR, treeRoot);
  return new PreopenDirectory(SESSION_MOUNT, entries);
};

/** Build a `WasiAdapter` from a fresh `WASI` instance over the OPFS
 *  preopen. The adapter is what `loadLsmModule` consumes.
 *
 *  The shim's `WASI.initialize` requires a structural type with
 *  `memory: WebAssembly.Memory` and optional `_initialize` —
 *  `WebAssembly.Instance` carries both but lib.dom types them as
 *  `Record<string, ExportValue>`. We re-extract the two fields via
 *  typeof / instanceof checks and pass a typed projection. No `as`
 *  cast; the runtime values are unchanged. */
const makeWasiAdapter = async (): Promise<WasiAdapter> => {
  const preopen = await buildOpfsRoot();
  const wasi = new WASI([], [], [preopen]);
  return {
    wasiImport: wasi.wasiImport,
    initialize: (instance) => {
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) {
        // Surface as a typed `BlobStoreError` rather than a generic
        // `Error` — the surrounding `Effect.try` in `module-loader.ts`
        // passes typed errors through via `instanceof` check, so the
        // upstream consumer sees a structured error with operation
        // metadata instead of a stringly-typed message.
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

// ───────────────────────────────────────────────────────────────────
// Module loader. Builds the `LsmModule` against the OPFS-backed
// WASI host, opens a session at `/data/lsm`, opens a default table,
// and returns the handles for the RPC handlers to close over.
// ───────────────────────────────────────────────────────────────────

interface WorkerState {
  readonly lsm: LsmModule;
  /** Open lsm-tree session handle, or `undefined` until first
   *  `LsmReopenAfterUpload` call. Session can't be opened at worker
   *  boot because `/data/lsm/` doesn't exist in OPFS yet — the popup
   *  drag-drop uploader populates it AFTER the worker starts. Opening
   *  eagerly here hangs the entire `HandlersLive` Layer build → the
   *  RpcServer never registers handlers → every popup→worker RPC
   *  queues indefinitely. Lazy-init via Reopen is the correct flow. */
  readonly sessionHandle: Ref.Ref<number | undefined>;
  readonly tableHandle: Ref.Ref<number | undefined>;
}

const makeWorkerState = Effect.gen(function* () {
  // WASM bytes now flow through the shared `WasmBytes` service (per
  // platform unification iter A) — fetch + arrayBuffer is the
  // adapter's job, not this caller's.
  const wasm = yield* WasmBytes;
  const wasmBytes = yield* wasm.load("lsm-tree").pipe(
    Effect.mapError((cause) => new BlobStoreError({ operation: "lsm", cause })),
  );
  const [jsffiFactory, wasi] = yield* Effect.tryPromise({
    try: async () => {
      const m = await import(jsffiUrl.href);
      const a = await makeWasiAdapter();
      return [m.default, a] as const;
    },
    catch: (cause) => new BlobStoreError({ operation: "lsm", cause }),
  });
  // `wasmBytes` is `Uint8Array<ArrayBufferLike>`. `loadLsmModule` declares
  // its first arg as `BufferSource` which (under lib.dom 2026)
  // narrowly requires `ArrayBufferView<ArrayBuffer>` — `ArrayBufferLike`
  // is rejected because it could be `SharedArrayBuffer`. Re-wrap into
  // a fresh `Uint8Array` whose backing buffer is statically known to
  // be `ArrayBuffer` so the structural check passes.
  const wasmBytesAB = new Uint8Array(wasmBytes);
  const lsm: LsmModule = yield* loadLsmModule({
    wasmBytes: wasmBytesAB,
    jsffiFactory,
    wasi,
  }).pipe(
    Effect.mapError((e: LsmWasmError) =>
      new BlobStoreError({ operation: "lsm", cause: e }),
    ),
  );
  const sessionHandle = yield* Ref.make<number | undefined>(undefined);
  const tableHandle = yield* Ref.make<number | undefined>(undefined);
  return { lsm, sessionHandle, tableHandle };
});

/** Resolve the open table handle or fail with a clear typed error.
 *  Used by every lsm-tree-operation handler (`LsmGet`/`LsmPut`/etc.)
 *  that requires a populated OPFS lsm-tree session. */
const requireTable = (state: WorkerState): Effect.Effect<number, BlobStoreError> =>
  Ref.get(state.tableHandle).pipe(
    Effect.flatMap((h) =>
      h === undefined
        ? Effect.fail(
            new BlobStoreError({
              operation: "lsm",
              cause:
                "lsm-tree session not open — call LsmReopenAfterUpload after populating OPFS",
            }),
          )
        : Effect.succeed(h),
    ),
  );

// ───────────────────────────────────────────────────────────────────
// OPFS upload sink. Tracks file handles by path so multi-chunk
// uploads to the same file reuse a single `FileSystemSyncAccessHandle`.
// The handle is closed when the chunk with `final: true` arrives.
// ───────────────────────────────────────────────────────────────────

interface UploadSink {
  /** Path → open sync handle for in-progress uploads. */
  readonly open: Map<string, FileSystemSyncAccessHandle>;
}

const newUploadSink = (): UploadSink => ({ open: new Map() });

const wrapBlobError = (cause: unknown) =>
  new BlobStoreError({ operation: "lsm", cause });

const writeChunk = (
  sink: UploadSink,
  path: string,
  offset: number,
  bytes: Uint8Array,
  final: boolean,
): Effect.Effect<void, BlobStoreError> =>
  Effect.tryPromise({
    try: async () => {
      lsmLog(`writeChunk enter path=${path} offset=${offset} bytes=${bytes.length} final=${final}`);
      let handle = sink.open.get(path);
      if (handle === undefined) {
        // Resolve parent path + create directory chain. OPFS API only
        // creates one level at a time, so we walk the split path.
        lsmLog(`writeChunk[${path}]: getDirectory ...`);
        const root = await navigator.storage.getDirectory();
        lsmLog(`writeChunk[${path}]: getDirectory done`);
        const segments = path.split("/").filter((s) => s.length > 0);
        const filename = segments.pop();
        if (filename === undefined) {
          throw new BlobStoreError({
            operation: "lsm",
            cause: `LsmUploadChunk: empty path "${path}" — at least one segment required`,
          });
        }
        let dir = root;
        for (const seg of segments) {
          lsmLog(`writeChunk[${path}]: getDirectoryHandle("${seg}") ...`);
          dir = await dir.getDirectoryHandle(seg, { create: true });
        }
        lsmLog(`writeChunk[${path}]: getFileHandle("${filename}") ...`);
        const file = await dir.getFileHandle(filename, { create: true });
        lsmLog(`writeChunk[${path}]: createSyncAccessHandle ...`);
        handle = await file.createSyncAccessHandle();
        lsmLog(`writeChunk[${path}]: createSyncAccessHandle done`);
        sink.open.set(path, handle);
      }
      handle.write(bytes, { at: offset });
      if (final) {
        handle.flush();
        handle.close();
        sink.open.delete(path);
      }
      lsmLog(`writeChunk exit path=${path}`);
    },
    catch: wrapBlobError,
  });

// ───────────────────────────────────────────────────────────────────
// RPC handlers. Each method maps an RPC payload onto the
// corresponding `LsmModule` op via the ref-tracked table handle.
// ───────────────────────────────────────────────────────────────────

const makeHandlers = (state: WorkerState, sink: UploadSink) => ({
  LsmGet: ({ key }: { readonly key: Uint8Array }) =>
    requireTable(state).pipe(
      Effect.flatMap((h) => state.lsm.get(h, key).pipe(Effect.mapError(wrapBlobError))),
      Effect.map((opt) => Option.getOrNull(opt)),
    ),

  LsmPut: ({ key, value }: { readonly key: Uint8Array; readonly value: Uint8Array }) =>
    requireTable(state).pipe(
      Effect.flatMap((h) => state.lsm.put(h, key, value).pipe(Effect.mapError(wrapBlobError))),
    ),

  LsmDelete: ({ key }: { readonly key: Uint8Array }) =>
    requireTable(state).pipe(
      Effect.flatMap((h) => state.lsm.delete(h, key).pipe(Effect.mapError(wrapBlobError))),
    ),

  LsmHas: ({ key }: { readonly key: Uint8Array }) =>
    requireTable(state).pipe(
      Effect.flatMap((h) => state.lsm.has(h, key).pipe(Effect.mapError(wrapBlobError))),
    ),

  LsmScan: ({ prefix }: { readonly prefix: Uint8Array }) =>
    Effect.gen(function* () {
      const tableH = yield* requireTable(state);
      const cursor = yield* state.lsm.cursorOpen(tableH, prefix);
      try {
        const collected: Array<{ readonly key: Uint8Array; readonly value: Uint8Array }> = [];
        // Drain the cursor synchronously into an array. For large
        // scans this could pull MBs into memory; the user-supplied
        // snapshot bootstrap is the only ≥100k-entry caller today
        // and it tolerates the buffering.
        let done = false;
        while (!done) {
          const batch = yield* state.lsm.cursorRead(cursor, 256);
          if (batch.entries.length === 0) {
            done = true;
            break;
          }
          for (const e of batch.entries) collected.push(e);
        }
        return collected;
      } finally {
        yield* state.lsm.cursorClose(cursor).pipe(Effect.ignore);
      }
    }).pipe(Effect.mapError(wrapBlobError)),

  LsmPutBatch: ({
    entries,
  }: {
    readonly entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>;
  }) =>
    requireTable(state).pipe(
      Effect.flatMap((h) => state.lsm.putBatch(h, entries).pipe(Effect.mapError(wrapBlobError))),
    ),

  LsmDeleteBatch: ({ keys }: { readonly keys: ReadonlyArray<Uint8Array> }) =>
    requireTable(state).pipe(
      Effect.flatMap((h) => state.lsm.deleteBatch(h, keys).pipe(Effect.mapError(wrapBlobError))),
    ),

  LsmUploadChunk: ({
    path,
    offset,
    bytes,
    final,
  }: {
    readonly path: string;
    readonly offset: number;
    readonly bytes: Uint8Array;
    readonly final: boolean;
  }) => writeChunk(sink, path, offset, bytes, final),

  LsmReopenAfterUpload: () =>
    Effect.gen(function* () {
      // Close any prior session/table if they were already open
      // (Reopen is idempotent — popup may call it multiple times,
      // e.g., re-drop a corrected snapshot after a partial upload).
      const oldTable = yield* Ref.get(state.tableHandle);
      const oldSession = yield* Ref.get(state.sessionHandle);
      if (oldTable !== undefined) {
        yield* state.lsm.closeTable(oldTable).pipe(Effect.ignore);
      }
      if (oldSession !== undefined) {
        yield* state.lsm.closeSession(oldSession).pipe(Effect.ignore);
      }
      // Open against the now-populated `/data/lsm/` tree. This is
      // the FIRST time `openSession` runs across the worker's
      // lifetime — moving it here (out of `makeWorkerState`)
      // unblocks the boot path when OPFS is empty.
      const sessionDir = `${SESSION_MOUNT}/${LSM_SESSION_SUBDIR}`;
      const session = yield* state.lsm.openSession(sessionDir);
      const table = yield* state.lsm.openTable(session, "default");
      yield* Ref.set(state.sessionHandle, session);
      yield* Ref.set(state.tableHandle, table);
    }).pipe(Effect.mapError(wrapBlobError)),

  // Inspect the OPFS tree under `/data/lsm/` to decide whether the
  // popup can offer a "resume" affordance instead of forcing a
  // fresh snapshot upload. Walks `navigator.storage.getDirectory()`
  // ASYNCHRONOUSLY (not via the sync access handles) so we don't
  // contend with in-flight session reads.
  LsmInspectOpfs: () =>
    Effect.tryPromise({
      try: async () => {
        const root = await navigator.storage.getDirectory();
        const lsm = await root
          .getDirectoryHandle(LSM_SESSION_SUBDIR, { create: false })
          .catch(() => null);
        if (lsm === null) {
          return { hasSession: false, hasSnapshots: false, byteCount: 0, lastModifiedMs: 0 };
        }
        const hasSession = await lsm
          .getDirectoryHandle("active", { create: false })
          .then(() => true)
          .catch(() => false);
        const hasSnapshots = await lsm
          .getDirectoryHandle("snapshots", { create: false })
          .then(() => true)
          .catch(() => false);
        let byteCount = 0;
        let lastModifiedMs = 0;
        const walk = async (dir: FileSystemDirectoryHandle): Promise<void> => {
          for await (const [, child] of dir.entries()) {
            if (child.kind === "file") {
              const file = await child.getFile();
              byteCount += file.size;
              if (file.lastModified > lastModifiedMs) lastModifiedMs = file.lastModified;
            } else {
              await walk(child);
            }
          }
        };
        await walk(lsm);
        return { hasSession, hasSnapshots, byteCount, lastModifiedMs };
      },
      catch: wrapBlobError,
    }),
});

// ───────────────────────────────────────────────────────────────────
// Worker bootstrap. The RpcServer reads from `BrowserWorkerRunner`
// (postMessage transport); handlers are the closures built above.
// ───────────────────────────────────────────────────────────────────

const HandlersLive = LsmRpcGroup.toLayer(
  Effect.gen(function* () {
    const state = yield* makeWorkerState;
    const sink = newUploadSink();
    return LsmRpcGroup.of(makeHandlers(state, sink));
  }),
);

const WorkerLive = RpcServer.layer(LsmRpcGroup).pipe(
  Layer.provide(HandlersLive),
  Layer.provide(WasmBytesUrlLayer({ "lsm-tree": wasmUrl })),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer),
);

Effect.runFork(Layer.launch(WorkerLive));
