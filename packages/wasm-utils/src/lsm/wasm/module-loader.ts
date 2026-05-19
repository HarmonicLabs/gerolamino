/**
 * Reactor-module loader for the wasm32-wasi lsm-tree shim.
 *
 * The post-link.mjs ESM stub exposes a single default export — a
 * factory `(__exports: Record<string, unknown>) => imports` — that
 * the canonical ghc-wasm-meta instantiation pattern requires. We
 * tie the knot by:
 *
 *   1. Allocating an empty `__exports` object.
 *   2. Calling the factory with that object to get the JSFFI imports.
 *   3. `WebAssembly.instantiate` with those + a host-supplied WASI
 *      imports table.
 *   4. Copying `instance.exports` into `__exports` so step 2's
 *      closures resolve when called.
 *   5. Invoking `wasi.initialize(instance)` (or the host's reactor-
 *      mode equivalent) and then `hs_init()` to boot the Haskell RTS.
 *
 * The output is an `LsmModule` whose operations are `Effect`s — each
 * cross-boundary call is wrapped in `Effect.tryPromise` so callers
 * compose with the rest of the Effect ecosystem (`Layer`, `Scope`,
 * structured concurrency) instead of bare Promises + `try/catch`.
 */
import { Effect, Option } from "effect";
import { LsmWasmError, liftLsmError } from "./errors.ts";

/** Host-agnostic WASI binding. Bun's `node:wasi`, Node's `node:wasi`,
 *  and browser WASI shims (`@bjorn3/browser_wasi_shim`, etc.) all
 *  conform to this shape. */
export interface WasiAdapter {
  /** The `wasi_snapshot_preview1` imports table passed to
   *  `WebAssembly.instantiate`. */
  readonly wasiImport: WebAssembly.ModuleImports;
  /** Reactor-mode initialiser — typically calls
   *  `instance.exports._initialize()` plus host-side bookkeeping. */
  initialize(instance: WebAssembly.Instance): void;
}

// ───────────────────────────────────────────────────────────────────
// WASM ABI boundary — types declared once per the linker exports
// manifest in `lsm-tree-wasm-shim.cabal` (`-optl-Wl,--export=…`).
//
// `instance.exports` is `Record<string, WebAssembly.ExportValue>` at
// the TS lib level. The loader projects it once into `LsmRawExports`
// and every downstream call goes through the typed view. New `hs_lsm_*`
// reactor functions land here AND in the cabal exports manifest.
//
// Pointer arguments are `number` (offsets into WASM linear memory).
// Status codes:
//   0 = ok          1 = miss (lookup/cursor empty)
//   2 = fault       3 = bad handle
// ───────────────────────────────────────────────────────────────────

interface LsmRawExports {
  readonly memory: WebAssembly.Memory;
  readonly malloc: (n: number) => number;
  readonly free: (p: number) => void;
  readonly hs_init: () => Promise<void>;
  // Legacy smoke entrypoints — kept for the Node end-to-end driver.
  readonly hs_lsm_smoke: (ptr: number, len: number) => Promise<number>;
  readonly hs_lsm_smoke_reopen: (ptr: number, len: number) => Promise<number>;
  // Session lifecycle.
  readonly hs_lsm_open_session: (
    pathPtr: number,
    pathLen: number,
    outHandlePtr: number,
  ) => Promise<number>;
  readonly hs_lsm_close_session: (handle: number) => Promise<number>;
  // Table lifecycle.
  readonly hs_lsm_open_table: (
    sessionHandle: number,
    labelPtr: number,
    labelLen: number,
    outHandlePtr: number,
  ) => Promise<number>;
  readonly hs_lsm_close_table: (handle: number) => Promise<number>;
  // KV operations.
  readonly hs_lsm_get: (
    tableHandle: number,
    keyPtr: number,
    keyLen: number,
    outBufPtrPtr: number,
    outLenPtr: number,
  ) => Promise<number>;
  readonly hs_lsm_put: (
    tableHandle: number,
    keyPtr: number,
    keyLen: number,
    valPtr: number,
    valLen: number,
  ) => Promise<number>;
  readonly hs_lsm_delete: (
    tableHandle: number,
    keyPtr: number,
    keyLen: number,
  ) => Promise<number>;
  readonly hs_lsm_has: (
    tableHandle: number,
    keyPtr: number,
    keyLen: number,
  ) => Promise<number>;
  // Batch operations.
  readonly hs_lsm_put_batch: (
    tableHandle: number,
    bufPtr: number,
    bufLen: number,
  ) => Promise<number>;
  readonly hs_lsm_delete_batch: (
    tableHandle: number,
    bufPtr: number,
    bufLen: number,
  ) => Promise<number>;
  // Cursor operations.
  readonly hs_lsm_cursor_open: (
    tableHandle: number,
    prefixPtr: number,
    prefixLen: number,
    outHandlePtr: number,
  ) => Promise<number>;
  readonly hs_lsm_cursor_read: (
    cursorHandle: number,
    maxCount: number,
    outBufPtrPtr: number,
    outLenPtr: number,
    outCountPtr: number,
  ) => Promise<number>;
  readonly hs_lsm_cursor_close: (handle: number) => Promise<number>;
  // Snapshot operations.
  readonly hs_lsm_save_snapshot: (
    tableHandle: number,
    namePtr: number,
    nameLen: number,
    labelPtr: number,
    labelLen: number,
  ) => Promise<number>;
  readonly hs_lsm_open_snapshot: (
    sessionHandle: number,
    namePtr: number,
    nameLen: number,
    labelPtr: number,
    labelLen: number,
    outHandlePtr: number,
  ) => Promise<number>;
}

/** Reactor status codes (mirror the Haskell `rc*` constants in `Main.hs`). */
export const LSM_RC = {
  ok: 0,
  miss: 1,
  fault: 2,
  badHandle: 3,
} as const;

/** A decoded cursor batch — flat key/value pairs read from a single
 *  `hs_lsm_cursor_read` call. */
export interface CursorBatch {
  readonly entries: ReadonlyArray<{
    readonly key: Uint8Array;
    readonly value: Uint8Array;
  }>;
}

/** Typed view of the lsm-tree shim's reactor surface — every
 *  `BlobStore`-shaped operation is exposed as an Effect that lifts
 *  its return code into `LsmWasmError` or a typed success value. */
export interface LsmModule {
  /** Legacy: open → 2× insert → 3× lookup → close against an empty
   *  session directory. Resolves to 0 on success. */
  smoke(sessionDir: string): Effect.Effect<number, LsmWasmError>;
  /** Legacy: open → 2× insert → saveSnapshot → close. The snapshot
   *  files survive in `<sessionDir>/snapshots/wasm-smoke/`. */
  smokeReopen(sessionDir: string): Effect.Effect<number, LsmWasmError>;

  /** Open a session at the given directory. The resulting handle
   *  must be passed to `closeSession` when the caller is done. */
  openSession(sessionDir: string): Effect.Effect<number, LsmWasmError>;
  closeSession(sessionHandle: number): Effect.Effect<void, LsmWasmError>;
  /** Open a new bytes→bytes table within a session. `label` is
   *  currently unused by the simple API but reserved for forward
   *  compat with labelled tables. */
  openTable(sessionHandle: number, label: string): Effect.Effect<number, LsmWasmError>;
  closeTable(tableHandle: number): Effect.Effect<void, LsmWasmError>;

  /** Look up a key. Returns `None` on miss; `Some(value)` on hit. */
  get(
    tableHandle: number,
    key: Uint8Array,
  ): Effect.Effect<Option.Option<Uint8Array>, LsmWasmError>;
  put(tableHandle: number, key: Uint8Array, value: Uint8Array): Effect.Effect<void, LsmWasmError>;
  delete(tableHandle: number, key: Uint8Array): Effect.Effect<void, LsmWasmError>;
  has(tableHandle: number, key: Uint8Array): Effect.Effect<boolean, LsmWasmError>;
  putBatch(
    tableHandle: number,
    entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>,
  ): Effect.Effect<void, LsmWasmError>;
  deleteBatch(
    tableHandle: number,
    keys: ReadonlyArray<Uint8Array>,
  ): Effect.Effect<void, LsmWasmError>;

  /** Open a cursor on the table. If `prefix` is empty, the cursor
   *  starts at the beginning; otherwise it starts at the given
   *  offset key. Must be closed via `closeCursor`. */
  cursorOpen(tableHandle: number, prefix: Uint8Array): Effect.Effect<number, LsmWasmError>;
  /** Read up to `maxCount` entries from the cursor. Returns an empty
   *  batch on cursor exhaustion. */
  cursorRead(
    cursorHandle: number,
    maxCount: number,
  ): Effect.Effect<CursorBatch, LsmWasmError>;
  cursorClose(cursorHandle: number): Effect.Effect<void, LsmWasmError>;

  saveSnapshot(
    tableHandle: number,
    name: string,
    label: string,
  ): Effect.Effect<void, LsmWasmError>;
  openSnapshot(
    sessionHandle: number,
    name: string,
    label: string,
  ): Effect.Effect<number, LsmWasmError>;

  /** Raw export table — escape hatch for callers that want to drive
   *  reactor functions that aren't yet wrapped here. */
  readonly raw: Record<string, unknown>;
}

export interface LsmFactoryConfig {
  /** Bytes of `lsm-tree-wasm.wasm` (read by the caller — Bun's
   *  `Bun.file(path).bytes()`, Node's `fs.readFile`, fetch in
   *  browser, etc.). */
  readonly wasmBytes: BufferSource;
  /** Factory exported by `lsm-tree-wasm.js` (post-link.mjs output).
   *  The caller imports the `.js` and forwards its default export. */
  readonly jsffiFactory: (
    __exports: Record<string, unknown>,
  ) => WebAssembly.ModuleImports;
  /** Host's WASI adapter — see `WasiAdapter`. */
  readonly wasi: WasiAdapter;
}

// ───────────────────────────────────────────────────────────────────
// Module-level singletons.
// ───────────────────────────────────────────────────────────────────

const utf8Encoder = new TextEncoder();

// ───────────────────────────────────────────────────────────────────
// Boundary projection — runs once at module load and produces a typed
// `LsmRawExports` from `Record<string, unknown>` via per-member
// validation + closure wrapping. No `as` casts anywhere — every
// member's runtime presence is checked, and the wrapping closure's
// declared signature constrains the call sites without static
// narrowing of the underlying `Function` type.
// ───────────────────────────────────────────────────────────────────

const exportMissing = (name: string): LsmWasmError =>
  new LsmWasmError({
    operation: "exportMissing",
    cause: `export '${name}' is missing or not a function`,
  });

/** Build a `(n: number) => number` closure over a validated export. */
const projectNumberInOutFn = (
  raw: Record<string, unknown>,
  name: string,
): Effect.Effect<(n: number) => number, LsmWasmError> => {
  const fn = raw[name];
  return typeof fn !== "function"
    ? Effect.fail(exportMissing(name))
    : Effect.succeed((n: number): number => {
        const result: unknown = fn(n);
        if (typeof result !== "number") {
          throw new LsmWasmError({
            operation: "reactorCall",
            cause: `${name} returned non-number: ${typeof result}`,
          });
        }
        return result;
      });
};

/** Build a `(p: number) => void` closure over a validated export. */
const projectVoidFn1 = (
  raw: Record<string, unknown>,
  name: string,
): Effect.Effect<(p: number) => void, LsmWasmError> => {
  const fn = raw[name];
  return typeof fn !== "function"
    ? Effect.fail(exportMissing(name))
    : Effect.succeed((p: number): void => {
        fn(p);
      });
};

/** Build an async closure that resolves to `void`. */
const projectAsyncVoidFn = (
  raw: Record<string, unknown>,
  name: string,
): Effect.Effect<() => Promise<void>, LsmWasmError> => {
  const fn = raw[name];
  return typeof fn !== "function"
    ? Effect.fail(exportMissing(name))
    : Effect.succeed(() => Promise.resolve(fn()).then(() => undefined));
};

/** Variadic-by-design `(...args) => Promise<number>` projector.
 *
 *  Reactor functions in the shim all share the shape "Word32 args
 *  in, Word32 status code out". This single helper wraps any arity
 *  by accepting `number[]` rest args; the declared return type
 *  `(...args: number[]) => Promise<number>` is a structural supertype
 *  of every arity-specific signature in `LsmRawExports`, so callers
 *  can assign the result directly. No `as` cast required — TS narrows
 *  the type at the assignment site. */
const projectAsyncRcFn = (
  raw: Record<string, unknown>,
  name: string,
): Effect.Effect<(...args: ReadonlyArray<number>) => Promise<number>, LsmWasmError> => {
  const fn = raw[name];
  return typeof fn !== "function"
    ? Effect.fail(exportMissing(name))
    : Effect.succeed((...args: ReadonlyArray<number>) =>
        Promise.resolve(fn(...args)).then((r: unknown) => {
          if (typeof r !== "number") {
            throw new LsmWasmError({
              operation: "reactorCall",
              cause: `${name} returned non-number: ${typeof r}`,
            });
          }
          return r;
        }),
      );
};

const projectRawExports = (
  raw: Record<string, unknown>,
): Effect.Effect<LsmRawExports, LsmWasmError> =>
  Effect.gen(function* () {
    if (!(raw.memory instanceof WebAssembly.Memory)) {
      return yield* new LsmWasmError({
        operation: "exportMissing",
        cause: "export 'memory' is not a WebAssembly.Memory",
      });
    }
    const malloc = yield* projectNumberInOutFn(raw, "malloc");
    const free = yield* projectVoidFn1(raw, "free");
    const hs_init = yield* projectAsyncVoidFn(raw, "hs_init");
    return {
      memory: raw.memory,
      malloc,
      free,
      hs_init,
      hs_lsm_smoke: yield* projectAsyncRcFn(raw, "hs_lsm_smoke"),
      hs_lsm_smoke_reopen: yield* projectAsyncRcFn(raw, "hs_lsm_smoke_reopen"),
      hs_lsm_open_session: yield* projectAsyncRcFn(raw, "hs_lsm_open_session"),
      hs_lsm_close_session: yield* projectAsyncRcFn(raw, "hs_lsm_close_session"),
      hs_lsm_open_table: yield* projectAsyncRcFn(raw, "hs_lsm_open_table"),
      hs_lsm_close_table: yield* projectAsyncRcFn(raw, "hs_lsm_close_table"),
      hs_lsm_get: yield* projectAsyncRcFn(raw, "hs_lsm_get"),
      hs_lsm_put: yield* projectAsyncRcFn(raw, "hs_lsm_put"),
      hs_lsm_delete: yield* projectAsyncRcFn(raw, "hs_lsm_delete"),
      hs_lsm_has: yield* projectAsyncRcFn(raw, "hs_lsm_has"),
      hs_lsm_put_batch: yield* projectAsyncRcFn(raw, "hs_lsm_put_batch"),
      hs_lsm_delete_batch: yield* projectAsyncRcFn(raw, "hs_lsm_delete_batch"),
      hs_lsm_cursor_open: yield* projectAsyncRcFn(raw, "hs_lsm_cursor_open"),
      hs_lsm_cursor_read: yield* projectAsyncRcFn(raw, "hs_lsm_cursor_read"),
      hs_lsm_cursor_close: yield* projectAsyncRcFn(raw, "hs_lsm_cursor_close"),
      hs_lsm_save_snapshot: yield* projectAsyncRcFn(raw, "hs_lsm_save_snapshot"),
      hs_lsm_open_snapshot: yield* projectAsyncRcFn(raw, "hs_lsm_open_snapshot"),
    };
  });

// ───────────────────────────────────────────────────────────────────
// WASM-memory helpers — manage the malloc/free boundary so callers
// never touch raw pointers directly. Every helper uses
// `Effect.acquireUseRelease` so a fault mid-call doesn't leak the
// linear-memory chunk (no GC in WASM linear memory).
// ───────────────────────────────────────────────────────────────────

/** Write a `Uint8Array` into a fresh WASM allocation, run an action
 *  against the pointer, and free the allocation on completion. */
const withBytes = <A, E>(
  exports: LsmRawExports,
  bytes: Uint8Array,
  use: (ptr: number, len: number) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const p = exports.malloc(bytes.length);
      new Uint8Array(exports.memory.buffer, p, bytes.length).set(bytes);
      return p;
    }),
    (p) => use(p, bytes.length),
    (p) => Effect.sync(() => exports.free(p)),
  );

/** Like `withBytes` but for a UTF-8 string. */
const withString = <A, E>(
  exports: LsmRawExports,
  str: string,
  use: (ptr: number, len: number) => Effect.Effect<A, E>,
): Effect.Effect<A, E> => withBytes(exports, utf8Encoder.encode(str), use);

/** Allocate `n` bytes of scratch, run the action, free on completion.
 *  Used for out-pointers passed to reactor functions. */
const withScratch = <A, E>(
  exports: LsmRawExports,
  n: number,
  use: (ptr: number) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => exports.malloc(n)),
    use,
    (p) => Effect.sync(() => exports.free(p)),
  );

/** Read a 32-bit unsigned integer at `ptr` from WASM linear memory. */
const readU32 = (exports: LsmRawExports, ptr: number): number =>
  new DataView(exports.memory.buffer).getUint32(ptr, true);

/** Copy `len` bytes starting at `ptr` into a fresh `Uint8Array`. The
 *  resulting array is independent of the WASM buffer (a future
 *  `memory.grow` could detach it). */
const readBytes = (exports: LsmRawExports, ptr: number, len: number): Uint8Array => {
  const out = new Uint8Array(len);
  out.set(new Uint8Array(exports.memory.buffer, ptr, len));
  return out;
};

/** Encode `[k_len:u32][k][v_len:u32][v]...` into a `Uint8Array` for
 *  putBatch wire format. */
const encodePutBatch = (
  entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>,
): Uint8Array => {
  const total = entries.reduce((s, e) => s + 4 + e.key.length + 4 + e.value.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const e of entries) {
    view.setUint32(off, e.key.length, true);
    out.set(e.key, off + 4);
    off += 4 + e.key.length;
    view.setUint32(off, e.value.length, true);
    out.set(e.value, off + 4);
    off += 4 + e.value.length;
  }
  return out;
};

/** Encode `[k_len:u32][k]...` for deleteBatch wire format. */
const encodeDeleteBatch = (keys: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = keys.reduce((s, k) => s + 4 + k.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const k of keys) {
    view.setUint32(off, k.length, true);
    out.set(k, off + 4);
    off += 4 + k.length;
  }
  return out;
};

/** Decode a cursor-read flat buffer (matches `writeEntries` in Haskell). */
const decodeBatch = (exports: LsmRawExports, ptr: number, len: number, count: number): CursorBatch => {
  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  const view = new DataView(exports.memory.buffer, ptr, len);
  let off = 0;
  for (let i = 0; i < count; i++) {
    const kLen = view.getUint32(off, true);
    off += 4;
    const key = readBytes(exports, ptr + off, kLen);
    off += kLen;
    const vLen = view.getUint32(off, true);
    off += 4;
    const value = readBytes(exports, ptr + off, vLen);
    off += vLen;
    entries.push({ key, value });
  }
  return { entries };
};

/** Lift a non-zero status code into `LsmWasmError`. `rcMiss` is NOT a
 *  fault for callers that handle it explicitly (e.g. `get` returns
 *  `Option.none`); those call paths inspect the rc themselves. */
const rcAssertOk = (operation: string, rc: number): Effect.Effect<void, LsmWasmError> =>
  rc === LSM_RC.ok
    ? Effect.void
    : Effect.fail(
        new LsmWasmError({
          operation: "reactorCall",
          cause: `${operation} returned status code ${rc}`,
        }),
      );

// ───────────────────────────────────────────────────────────────────
// Module factory.
// ───────────────────────────────────────────────────────────────────

/**
 * Load + instantiate the lsm-tree reactor module.
 *
 * Returns a typed `LsmModule` with the high-level smoke ops + a raw
 * exports escape hatch. The Haskell RTS is booted before this resolves;
 * subsequent operations go straight to the reactor functions.
 *
 * Errors are surfaced as `LsmWasmError` discriminated by `operation`,
 * so callers can `Match.value(e.operation)` to handle compile failures
 * differently from runtime reactor faults.
 */
export const loadLsmModule = (
  config: LsmFactoryConfig,
): Effect.Effect<LsmModule, LsmWasmError> =>
  Effect.gen(function* () {
    const __exports: Record<string, unknown> = {};
    const module = yield* Effect.tryPromise({
      try: () => WebAssembly.compile(config.wasmBytes),
      catch: (cause) => liftLsmError("compile", cause),
    });
    const instance = yield* Effect.tryPromise({
      try: () =>
        WebAssembly.instantiate(module, {
          ghc_wasm_jsffi: config.jsffiFactory(__exports),
          wasi_snapshot_preview1: config.wasi.wasiImport,
        }),
      catch: (cause) => liftLsmError("instantiate", cause),
    });
    Object.assign(__exports, instance.exports);

    yield* Effect.try({
      try: () => config.wasi.initialize(instance),
      catch: (cause) => liftLsmError("wasiInitialize", cause),
    });

    const exports = yield* projectRawExports(__exports);
    yield* Effect.tryPromise({
      try: () => exports.hs_init(),
      catch: (cause) => liftLsmError("hsInit", cause),
    });

    // ─────────────────────────────────────────────────────────────
    // High-level wrappers — each composes the WASM-memory helpers
    // with one or more reactor calls and lifts status codes into
    // either a typed value or a `LsmWasmError`.
    // ─────────────────────────────────────────────────────────────

    const callRc = (op: string, fn: () => Promise<number>) =>
      Effect.tryPromise({
        try: fn,
        catch: (cause) => liftLsmError("reactorCall", cause),
      }).pipe(Effect.tap((rc) => rcAssertOk(op, rc)));

    const openSession = (sessionDir: string) =>
      withString(exports, sessionDir, (pathPtr, pathLen) =>
        withScratch(exports, 4, (outHandlePtr) =>
          callRc("hs_lsm_open_session", () =>
            exports.hs_lsm_open_session(pathPtr, pathLen, outHandlePtr),
          ).pipe(Effect.map(() => readU32(exports, outHandlePtr))),
        ),
      );

    const closeSession = (h: number) =>
      callRc("hs_lsm_close_session", () => exports.hs_lsm_close_session(h)).pipe(Effect.asVoid);

    const openTable = (sessionHandle: number, label: string) =>
      withString(exports, label, (labelPtr, labelLen) =>
        withScratch(exports, 4, (outHandlePtr) =>
          callRc("hs_lsm_open_table", () =>
            exports.hs_lsm_open_table(sessionHandle, labelPtr, labelLen, outHandlePtr),
          ).pipe(Effect.map(() => readU32(exports, outHandlePtr))),
        ),
      );

    const closeTable = (h: number) =>
      callRc("hs_lsm_close_table", () => exports.hs_lsm_close_table(h)).pipe(Effect.asVoid);

    const get = (tableHandle: number, key: Uint8Array) =>
      withBytes(exports, key, (keyPtr, keyLen) =>
        withScratch(exports, 8, (scratch) => {
          const outBufPtrPtr = scratch;
          const outLenPtr = scratch + 4;
          return Effect.tryPromise({
            try: () => exports.hs_lsm_get(tableHandle, keyPtr, keyLen, outBufPtrPtr, outLenPtr),
            catch: (cause) => liftLsmError("reactorCall", cause),
          }).pipe(
            Effect.flatMap((rc) => {
              if (rc === LSM_RC.miss) return Effect.succeed(Option.none<Uint8Array>());
              if (rc !== LSM_RC.ok)
                return Effect.fail(
                  new LsmWasmError({
                    operation: "reactorCall",
                    cause: `hs_lsm_get returned ${rc}`,
                  }),
                );
              const bufPtr = readU32(exports, outBufPtrPtr);
              const bufLen = readU32(exports, outLenPtr);
              const value = readBytes(exports, bufPtr, bufLen);
              exports.free(bufPtr);
              return Effect.succeed(Option.some(value));
            }),
          );
        }),
      );

    const put = (tableHandle: number, key: Uint8Array, value: Uint8Array) =>
      withBytes(exports, key, (keyPtr, keyLen) =>
        withBytes(exports, value, (valPtr, valLen) =>
          callRc("hs_lsm_put", () =>
            exports.hs_lsm_put(tableHandle, keyPtr, keyLen, valPtr, valLen),
          ).pipe(Effect.asVoid),
        ),
      );

    const del = (tableHandle: number, key: Uint8Array) =>
      withBytes(exports, key, (keyPtr, keyLen) =>
        callRc("hs_lsm_delete", () => exports.hs_lsm_delete(tableHandle, keyPtr, keyLen)).pipe(
          Effect.asVoid,
        ),
      );

    const has = (tableHandle: number, key: Uint8Array) =>
      withBytes(exports, key, (keyPtr, keyLen) =>
        Effect.tryPromise({
          try: () => exports.hs_lsm_has(tableHandle, keyPtr, keyLen),
          catch: (cause) => liftLsmError("reactorCall", cause),
        }).pipe(
          Effect.flatMap((rc) =>
            rc === LSM_RC.ok
              ? Effect.succeed(true)
              : rc === LSM_RC.miss
                ? Effect.succeed(false)
                : Effect.fail(
                    new LsmWasmError({
                      operation: "reactorCall",
                      cause: `hs_lsm_has returned ${rc}`,
                    }),
                  ),
          ),
        ),
      );

    const putBatch = (
      tableHandle: number,
      entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>,
    ) =>
      entries.length === 0
        ? Effect.void
        : withBytes(exports, encodePutBatch(entries), (bufPtr, bufLen) =>
            callRc("hs_lsm_put_batch", () =>
              exports.hs_lsm_put_batch(tableHandle, bufPtr, bufLen),
            ).pipe(Effect.asVoid),
          );

    const deleteBatch = (tableHandle: number, keys: ReadonlyArray<Uint8Array>) =>
      keys.length === 0
        ? Effect.void
        : withBytes(exports, encodeDeleteBatch(keys), (bufPtr, bufLen) =>
            callRc("hs_lsm_delete_batch", () =>
              exports.hs_lsm_delete_batch(tableHandle, bufPtr, bufLen),
            ).pipe(Effect.asVoid),
          );

    const cursorOpen = (tableHandle: number, prefix: Uint8Array) =>
      withBytes(exports, prefix, (prefixPtr, prefixLen) =>
        withScratch(exports, 4, (outHandlePtr) =>
          callRc("hs_lsm_cursor_open", () =>
            exports.hs_lsm_cursor_open(tableHandle, prefixPtr, prefixLen, outHandlePtr),
          ).pipe(Effect.map(() => readU32(exports, outHandlePtr))),
        ),
      );

    const cursorRead = (cursorHandle: number, maxCount: number) =>
      withScratch(exports, 12, (scratch) => {
        const outBufPtrPtr = scratch;
        const outLenPtr = scratch + 4;
        const outCountPtr = scratch + 8;
        return Effect.tryPromise({
          try: () =>
            exports.hs_lsm_cursor_read(
              cursorHandle,
              maxCount,
              outBufPtrPtr,
              outLenPtr,
              outCountPtr,
            ),
          catch: (cause) => liftLsmError("reactorCall", cause),
        }).pipe(
          Effect.flatMap((rc) => {
            if (rc === LSM_RC.miss) return Effect.succeed<CursorBatch>({ entries: [] });
            if (rc !== LSM_RC.ok)
              return Effect.fail(
                new LsmWasmError({
                  operation: "reactorCall",
                  cause: `hs_lsm_cursor_read returned ${rc}`,
                }),
              );
            const bufPtr = readU32(exports, outBufPtrPtr);
            const bufLen = readU32(exports, outLenPtr);
            const count = readU32(exports, outCountPtr);
            const batch = decodeBatch(exports, bufPtr, bufLen, count);
            exports.free(bufPtr);
            return Effect.succeed(batch);
          }),
        );
      });

    const cursorClose = (h: number) =>
      callRc("hs_lsm_cursor_close", () => exports.hs_lsm_cursor_close(h)).pipe(Effect.asVoid);

    const saveSnapshot = (tableHandle: number, name: string, label: string) =>
      withString(exports, name, (namePtr, nameLen) =>
        withString(exports, label, (labelPtr, labelLen) =>
          callRc("hs_lsm_save_snapshot", () =>
            exports.hs_lsm_save_snapshot(tableHandle, namePtr, nameLen, labelPtr, labelLen),
          ).pipe(Effect.asVoid),
        ),
      );

    const openSnapshot = (sessionHandle: number, name: string, label: string) =>
      withString(exports, name, (namePtr, nameLen) =>
        withString(exports, label, (labelPtr, labelLen) =>
          withScratch(exports, 4, (outHandlePtr) =>
            callRc("hs_lsm_open_snapshot", () =>
              exports.hs_lsm_open_snapshot(
                sessionHandle,
                namePtr,
                nameLen,
                labelPtr,
                labelLen,
                outHandlePtr,
              ),
            ).pipe(Effect.map(() => readU32(exports, outHandlePtr))),
          ),
        ),
      );

    return {
      smoke: (dir) => withString(exports, dir, (p, l) => callRc("hs_lsm_smoke", () => exports.hs_lsm_smoke(p, l))),
      smokeReopen: (dir) =>
        withString(exports, dir, (p, l) =>
          callRc("hs_lsm_smoke_reopen", () => exports.hs_lsm_smoke_reopen(p, l)),
        ),
      openSession,
      closeSession,
      openTable,
      closeTable,
      get,
      put,
      delete: del,
      has,
      putBatch,
      deleteBatch,
      cursorOpen,
      cursorRead,
      cursorClose,
      saveSnapshot,
      openSnapshot,
      raw: __exports,
    };
  });
