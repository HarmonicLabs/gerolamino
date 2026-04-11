/**
 * BlobStore layer backed by lsm-tree via Zig bridge.
 *
 * The Zig bridge (liblsm-bridge.so) wraps the Haskell lsm-ffi exports
 * with a buffer-based API. No raw pointer handling — TypeScript passes
 * Uint8Array buffers, Zig copies data in/out.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { Config, Effect, Layer, Option, Schema, Stream } from "effect";
import { BlobStore, prefixEnd } from "storage";

/** Typed error for LSM bridge FFI failures. */
export class LsmBridgeError extends Schema.TaggedErrorClass<LsmBridgeError>()(
  "LsmBridgeError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

/** Config key for the path to liblsm-bridge.so. Yieldable in Effect.gen. */
export const LsmBridgePath = Config.string("LIBLSM_BRIDGE_PATH");

const BRIDGE_SYMBOLS = {
  lsm_bridge_init: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_init_from_snapshot: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_open_snapshot: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_put: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_get: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.int,
  },
  lsm_bridge_delete: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_scan: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.int,
  },
  lsm_bridge_snapshot: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_cursor_open: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.int,
  },
  lsm_bridge_cursor_close: {
    args: [FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_cursor_read: {
    args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.int,
  },
} as const;

type BridgeLib = ReturnType<typeof dlopen<typeof BRIDGE_SYMBOLS>>["symbols"];

const lenBuf = new BigUint64Array(1);

/** Number of entries to read per cursor batch. */
const CURSOR_BATCH_SIZE = 256;

const lsmGet = (ffi: BridgeLib, key: Uint8Array): Effect.Effect<Option.Option<Uint8Array>, LsmBridgeError> =>
  Effect.gen(function* () {
    lenBuf[0] = 0n;
    const rc1 = ffi.lsm_bridge_get(ptr(key), key.byteLength, null, 0, lenBuf);
    if (rc1 === 1) return Option.none();
    if (rc1 !== 0) return yield* new LsmBridgeError({ operation: "get", cause: `lsm_bridge_get phase 1 returned ${rc1}` });
    const len = Number(lenBuf[0]);
    if (len === 0) return Option.some(new Uint8Array(0));
    const outBuf = new Uint8Array(len);
    lenBuf[0] = 0n;
    const rc2 = ffi.lsm_bridge_get(ptr(key), key.byteLength, ptr(outBuf), len, lenBuf);
    if (rc2 !== 0) return yield* new LsmBridgeError({ operation: "get", cause: `lsm_bridge_get phase 2 returned ${rc2}` });
    return Option.some(outBuf);
  });

/** Parse the flat [key_len:u32 LE][key][val_len:u32 LE][val]... buffer. */
const parseBatch = (buf: Uint8Array, count: number) => {
  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  const view = new DataView(buf.buffer, buf.byteOffset);
  let off = 0;
  for (let i = 0; i < count; i++) {
    const kLen = view.getUint32(off, true);
    off += 4;
    const key = buf.slice(off, off + kLen);
    off += kLen;
    const vLen = view.getUint32(off, true);
    off += 4;
    const value = buf.slice(off, off + vLen);
    off += vLen;
    entries.push({ key, value });
  }
  return entries;
};

/** Compare two Uint8Arrays lexicographically. Returns true if a < b. */
const lessThan = (a: Uint8Array, b: Uint8Array): boolean => {
  const len = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i++) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return a.byteLength < b.byteLength;
};

/** Build BlobStore operations from an initialized FFI handle. */
const makeBlobStoreOps = (ffi: BridgeLib) => ({
  get: (key: Uint8Array) => lsmGet(ffi, key),

  put: (key: Uint8Array, value: Uint8Array) =>
    Effect.sync(() => { ffi.lsm_bridge_put(ptr(key), key.byteLength, ptr(value), value.byteLength); }),

  delete: (key: Uint8Array) =>
    Effect.sync(() => { ffi.lsm_bridge_delete(ptr(key), key.byteLength); }),

  has: (key: Uint8Array) =>
    Effect.sync(() => {
      lenBuf[0] = 0n;
      return ffi.lsm_bridge_get(ptr(key), key.byteLength, null, 0, lenBuf) === 0;
    }),

  scan: (prefix: Uint8Array) => {
    const hi = prefixEnd(prefix);

    const openCursor = Effect.gen(function* () {
      const handleBuf = new BigUint64Array(1);
      const openRc = prefix.byteLength > 0
        ? ffi.lsm_bridge_cursor_open(ptr(prefix), prefix.byteLength, handleBuf)
        : ffi.lsm_bridge_cursor_open(null, 0, handleBuf);
      if (openRc !== 0) return yield* new LsmBridgeError({ operation: "cursor_open", cause: `lsm_bridge_cursor_open returned ${openRc}` });
      const handle = handleBuf[0]!;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => { ffi.lsm_bridge_cursor_close(handle); }),
      );
      return handle;
    });

    const readBatch = (handle: bigint) =>
      Effect.gen(function* () {
        const outLen = new BigUint64Array(1);
        const outCount = new BigUint64Array(1);
        const rc1 = ffi.lsm_bridge_cursor_read(handle, CURSOR_BATCH_SIZE, null, outLen, outCount);
        if (rc1 === 1) return undefined;
        if (rc1 !== 0) return yield* new LsmBridgeError({ operation: "cursor_read", cause: `lsm_bridge_cursor_read phase 1 returned ${rc1}` });
        const count = Number(outCount[0]);
        const totalLen = Number(outLen[0]);
        if (count === 0 || totalLen === 0) return undefined;
        const buf = new Uint8Array(totalLen);
        const rc2 = ffi.lsm_bridge_cursor_read(handle, CURSOR_BATCH_SIZE, ptr(buf), outLen, outCount);
        if (rc2 !== 0) return yield* new LsmBridgeError({ operation: "cursor_read", cause: `lsm_bridge_cursor_read phase 2 returned ${rc2}` });
        return parseBatch(buf, count);
      });

    return openCursor.pipe(
      Effect.map((handle) =>
        Stream.unfold(handle, (h) =>
          readBatch(h).pipe(
            Effect.map((batch) => {
              if (batch === undefined) return undefined;
              const filtered = hi.byteLength > 0
                ? batch.filter((e) => lessThan(e.key, hi))
                : batch;
              if (filtered.length === 0) return undefined;
              return [filtered, h] as const;
            }),
          ),
        ).pipe(Stream.flatMap((entries) => Stream.fromIterable(entries))),
      ),
      Stream.unwrap,
      Stream.scoped,
    );
  },

  putBatch: (entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>) =>
    Effect.sync(() => {
      for (const { key, value } of entries)
        ffi.lsm_bridge_put(ptr(key), key.byteLength, ptr(value), value.byteLength);
    }),

  deleteBatch: (keys: ReadonlyArray<Uint8Array>) =>
    Effect.sync(() => {
      for (const key of keys) ffi.lsm_bridge_delete(ptr(key), key.byteLength);
    }),
});

/**
 * BlobStore layer backed by lsm-tree via Zig bridge.
 * Reads LIBLSM_BRIDGE_PATH from Effect Config.
 * @param dataDir Path to LSM data directory (creates new empty table)
 */
export const layerLsm = (dataDir: string) =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const libPath = yield* LsmBridgePath;
      const ffi = dlopen(libPath, BRIDGE_SYMBOLS).symbols;
      const pathBytes = new TextEncoder().encode(dataDir);
      ffi.lsm_bridge_init(ptr(pathBytes), pathBytes.byteLength);
      return makeBlobStoreOps(ffi);
    }),
  );

/** Default snapshot label used by cardano-node V2LSM. */
const DEFAULT_SNAPSHOT_LABEL = "UTxO table";

/**
 * BlobStore layer from an existing V2LSM snapshot.
 * Opens a session at sessionDir and restores a table from snapshotName.
 * @param sessionDir Path to the LSM session directory (containing snapshots/)
 * @param snapshotName Name of the snapshot to restore
 * @param label Snapshot label for validation (default: "UTxO table" for cardano-node compatibility)
 */
export const layerLsmFromSnapshot = (sessionDir: string, snapshotName: string, label = DEFAULT_SNAPSHOT_LABEL) =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const libPath = yield* LsmBridgePath;
      const ffi = dlopen(libPath, BRIDGE_SYMBOLS).symbols;
      const pathBytes = new TextEncoder().encode(sessionDir);
      const nameBytes = new TextEncoder().encode(snapshotName);
      const labelBytes = new TextEncoder().encode(label);
      ffi.lsm_bridge_init_from_snapshot(
        ptr(pathBytes), pathBytes.byteLength,
        ptr(nameBytes), nameBytes.byteLength,
        ptr(labelBytes), labelBytes.byteLength,
      );
      return makeBlobStoreOps(ffi);
    }),
  );
