/**
 * `BlobStore` Layer backed by the WASM-compiled lsm-tree shim.
 *
 * Mirrors the existing Zig-backed `layerLsm` in `../lsm/layer-lsm.ts`
 * — same `BlobStore` + `LsmAdmin` service shape, same wire format
 * for cursor reads, same prefix-scan semantics. The only difference
 * is the FFI substrate: native `liblsm-bridge.so` via `bun:ffi` →
 * WASM `lsm-tree-wasm.wasm` via `loadLsmModule`.
 *
 * Layer lifecycle:
 *   1. Load + instantiate the WASM module (`loadLsmModule`).
 *   2. Open a session at the configured directory (`openSession`).
 *   3. Open the table inside the session (`openTable`).
 *   4. Hand a `BlobStore` + `LsmAdmin` Context to consumers.
 *   5. On Layer scope exit: close the table, close the session.
 *
 * Cursor lifetimes are independently scoped — `scan` opens + closes
 * each cursor inside the resulting `Stream`. Concurrent `scan` calls
 * on the same table are safe (each gets its own cursor handle).
 */
import { Context, Effect, Layer, Stream } from "effect";
import { type BlobEntry, BlobStore, BlobStoreError } from "../blob-store.ts";
import { prefixEnd } from "../keys.ts";
import { LsmAdmin, LsmAdminError } from "../native/admin.ts";
import { LsmWasmError } from "./errors.ts";
import {
  type CursorBatch,
  loadLsmModule,
  type LsmFactoryConfig,
  type LsmModule,
} from "./module-loader.ts";

/** Number of entries to read per `cursorRead` call. Matches the
 *  Zig-backed `layer-lsm.ts` to keep parity tests honest. */
const CURSOR_BATCH_SIZE = 256;

/** Default snapshot label used by cardano-node V2LSM. Same default as
 *  the Zig-backed bridge so existing snapshots interop. */
const DEFAULT_SNAPSHOT_LABEL = "UTxO table";

/** Lift a `LsmWasmError` (or any thrown defect) into a `BlobStoreError`. */
const toBlobStoreError = (cause: unknown): BlobStoreError =>
  new BlobStoreError({ operation: "lsm", cause });

/** Lift a `LsmWasmError` into an `LsmAdminError` for snapshot ops. */
const toLsmAdminError = (operation: "snapshot" | "openSnapshot") =>
  (cause: unknown): LsmAdminError => new LsmAdminError({ operation, cause });

/** Compare two `Uint8Array`s lexicographically — true if `a < b`. */
const lessThan = (a: Uint8Array, b: Uint8Array): boolean => {
  const len = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return a.byteLength < b.byteLength;
};

/** Build BlobStore operations that read the live table handle from a
 *  ref on every call. Reading by reference rather than by value lets
 *  `LsmAdmin.openSnapshot` rotate the underlying table without
 *  invalidating in-flight `BlobStore` invocations. */
const makeBlobStoreOps = (lsm: LsmModule, ref: { current: number }) => ({
  get: (key: Uint8Array) =>
    lsm.get(ref.current, key).pipe(Effect.mapError(toBlobStoreError)),

  put: (key: Uint8Array, value: Uint8Array) =>
    lsm.put(ref.current, key, value).pipe(Effect.mapError(toBlobStoreError)),

  delete: (key: Uint8Array) =>
    lsm.delete(ref.current, key).pipe(Effect.mapError(toBlobStoreError)),

  has: (key: Uint8Array) =>
    lsm.has(ref.current, key).pipe(Effect.mapError(toBlobStoreError)),

  /** Prefix scan: open a cursor at `prefix`, drain batches lazily,
   *  stop when the cursor returns < CURSOR_BATCH_SIZE entries OR the
   *  first key in a batch is >= `prefixEnd(prefix)`. */
  scan: (prefix: Uint8Array): Stream.Stream<BlobEntry, BlobStoreError> => {
    const hi = prefixEnd(prefix);
    // Build the cursor + Stream inside an Effect that requires a
    // `Scope`. `Stream.unwrap` then removes the `Scope` requirement
    // from the resulting Stream's R channel.
    const program = Effect.gen(function* () {
      const cursor = yield* Effect.acquireRelease(
        lsm.cursorOpen(ref.current, prefix).pipe(Effect.mapError(toBlobStoreError)),
        (h) => lsm.cursorClose(h).pipe(Effect.ignore),
      );
      // `Stream.unfold` yields `[chunk, nextSeed] | undefined`. Each
      // chunk is a single `BlobEntry` (we flatten the batch via
      // `flatMap(fromIterable)` to emit per-entry rather than per-batch).
      const batches: Stream.Stream<ReadonlyArray<BlobEntry>, BlobStoreError> = Stream.unfold(
        cursor,
        (h) =>
          lsm.cursorRead(h, CURSOR_BATCH_SIZE).pipe(
            Effect.map((batch: CursorBatch) => {
              if (batch.entries.length === 0) return undefined;
              const filtered =
                hi.byteLength > 0
                  ? batch.entries.filter((e) => lessThan(e.key, hi))
                  : batch.entries;
              if (filtered.length === 0) return undefined;
              return [filtered, h] as const;
            }),
            Effect.mapError(toBlobStoreError),
          ),
      );
      return batches.pipe(Stream.flatMap((entries) => Stream.fromIterable(entries)));
    });
    return Stream.unwrap(program);
  },

  putBatch: (entries: ReadonlyArray<BlobEntry>) =>
    lsm.putBatch(ref.current, entries).pipe(Effect.mapError(toBlobStoreError)),

  deleteBatch: (keys: ReadonlyArray<Uint8Array>) =>
    lsm.deleteBatch(ref.current, keys).pipe(Effect.mapError(toBlobStoreError)),
});

/** Build LsmAdmin operations bound to a single session + table. */
const makeAdminOps = (lsm: LsmModule, sessionHandle: number, tableHandleRef: { current: number }) => ({
  snapshot: (name: string, label: string = DEFAULT_SNAPSHOT_LABEL) =>
    lsm.saveSnapshot(tableHandleRef.current, name, label).pipe(
      Effect.mapError(toLsmAdminError("snapshot")),
    ),

  openSnapshot: (name: string, label: string = DEFAULT_SNAPSHOT_LABEL) =>
    Effect.gen(function* () {
      // Open the snapshot's table; this returns a NEW table handle.
      // Swap the live tableHandle in the ref so future BlobStore ops
      // target the restored table. Close the old handle on success.
      const newTable = yield* lsm.openSnapshot(sessionHandle, name, label);
      const oldTable = tableHandleRef.current;
      tableHandleRef.current = newTable;
      yield* lsm.closeTable(oldTable).pipe(Effect.ignore);
    }).pipe(Effect.mapError(toLsmAdminError("openSnapshot"))),
});

export interface LayerLsmWasmConfig extends LsmFactoryConfig {
  /** Path on the host filesystem where the lsm-tree session opens.
   *  Bun/Node: real path (e.g. `/var/lib/gerolamino/lsm`).
   *  chrome-ext: a path INSIDE the WASI shim's preopen root (e.g.
   *  `/data/lsm` when the OPFS shim mounts `/data` as the preopened
   *  directory). */
  readonly sessionDir: string;
  /** Optional label for the opened table. Reserved for the
   *  forward-compat label-aware Simple API; currently a no-op. */
  readonly tableLabel?: string;
}

/**
 * Build a Layer providing `BlobStore` + `LsmAdmin` backed by the
 * WASM lsm-tree shim. Equivalent to the Zig-backed `layerLsm` in
 * `../lsm/layer-lsm.ts` — same BlobStore semantics, same snapshot
 * label default. Drop-in replacement.
 *
 * The Layer holds the session + table handles for its lifetime; on
 * scope exit, the table is closed first, then the session.
 */
export const layerLsmWasm = (
  config: LayerLsmWasmConfig,
): Layer.Layer<BlobStore | LsmAdmin, LsmWasmError> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const lsm = yield* loadLsmModule(config);

      // Session lifecycle bound to the Layer scope.
      const sessionHandle = yield* Effect.acquireRelease(
        lsm.openSession(config.sessionDir),
        (h) => lsm.closeSession(h).pipe(Effect.ignore),
      );

      // Table handle is mutable (openSnapshot can swap it) — stored
      // in a mini-ref so admin ops can rotate it atomically.
      const initialTable = yield* Effect.acquireRelease(
        lsm.openTable(sessionHandle, config.tableLabel ?? "default"),
        (h) => lsm.closeTable(h).pipe(Effect.ignore),
      );
      const tableHandleRef = { current: initialTable };

      return Context.make(BlobStore, makeBlobStoreOps(lsm, tableHandleRef)).pipe(
        Context.add(LsmAdmin, makeAdminOps(lsm, sessionHandle, tableHandleRef)),
      );
    }),
  );
