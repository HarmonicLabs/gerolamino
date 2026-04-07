/**
 * BlobStore layer backed by lsm-tree via Zig bridge.
 *
 * The Zig bridge (liblsm-bridge.so) wraps the Haskell lsm-ffi exports
 * with a buffer-based API. No raw pointer handling — TypeScript passes
 * Uint8Array buffers, Zig copies data in/out.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { Config, Effect, Layer, Stream } from "effect";
import { BlobStore, BlobStoreError } from "storage/blob-store/service";
import { prefixEnd } from "storage/blob-store/keys";

/** Config key for the path to liblsm-bridge.so. Yieldable in Effect.gen. */
export const LsmBridgePath = Config.string("LIBLSM_BRIDGE_PATH");

const BRIDGE_SYMBOLS = {
  lsm_bridge_init: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_init_from_snapshot: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_open_snapshot: {
    args: [FFIType.ptr, FFIType.u64],
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
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
} as const;

type BridgeLib = ReturnType<typeof dlopen<typeof BRIDGE_SYMBOLS>>["symbols"];

const fail = (operation: string, cause: unknown) =>
  new BlobStoreError({ operation, cause });

const lenBuf = new BigUint64Array(1);

const lsmGet = (ffi: BridgeLib, key: Uint8Array): Uint8Array | undefined => {
  lenBuf[0] = 0n;
  const rc1 = ffi.lsm_bridge_get(ptr(key), key.byteLength, null, 0, lenBuf);
  if (rc1 === 1) return undefined;
  if (rc1 !== 0) throw `lsm_bridge_get phase 1 returned ${rc1}`;
  const len = Number(lenBuf[0]);
  if (len === 0) return new Uint8Array(0);
  const outBuf = new Uint8Array(len);
  lenBuf[0] = 0n;
  const rc2 = ffi.lsm_bridge_get(ptr(key), key.byteLength, ptr(outBuf), len, lenBuf);
  if (rc2 !== 0) throw `lsm_bridge_get phase 2 returned ${rc2}`;
  return outBuf;
};

/** Build BlobStore operations from an initialized FFI handle. */
const makeBlobStoreOps = (ffi: BridgeLib) => ({
  get: (key: Uint8Array) =>
    Effect.try({ try: () => lsmGet(ffi, key), catch: (cause) => fail("get", cause) }),

  put: (key: Uint8Array, value: Uint8Array) =>
    Effect.try({
      try: () => {
        const rc = ffi.lsm_bridge_put(ptr(key), key.byteLength, ptr(value), value.byteLength);
        if (rc !== 0) throw `lsm_bridge_put returned ${rc}`;
      },
      catch: (cause) => fail("put", cause),
    }),

  delete: (key: Uint8Array) =>
    Effect.try({
      try: () => {
        const rc = ffi.lsm_bridge_delete(ptr(key), key.byteLength);
        if (rc !== 0) throw `lsm_bridge_delete returned ${rc}`;
      },
      catch: (cause) => fail("delete", cause),
    }),

  has: (key: Uint8Array) =>
    Effect.try({
      try: () => {
        lenBuf[0] = 0n;
        return ffi.lsm_bridge_get(ptr(key), key.byteLength, null, 0, lenBuf) === 0;
      },
      catch: (cause) => fail("has", cause),
    }),

  scan: (prefix: Uint8Array) => {
    const hi = prefixEnd(prefix);
    return Stream.fromEffect(
      Effect.try({
        try: () => {
          const outLen = new BigUint64Array(1);
          const outCount = new BigUint64Array(1);
          const rc1 = ffi.lsm_bridge_scan(
            ptr(prefix), prefix.byteLength,
            ptr(hi.byteLength > 0 ? hi : prefix),
            hi.byteLength > 0 ? hi.byteLength : prefix.byteLength,
            null, outLen, outCount,
          );
          if (rc1 !== 0) throw `lsm_bridge_scan phase 1 returned ${rc1}`;
          const count = Number(outCount[0]);
          const totalLen = Number(outLen[0]);
          if (count === 0 || totalLen === 0) {
            const empty: Array<{ key: Uint8Array; value: Uint8Array }> = [];
            return empty;
          }
          const buf = new Uint8Array(totalLen);
          const rc2 = ffi.lsm_bridge_scan(
            ptr(prefix), prefix.byteLength,
            ptr(hi.byteLength > 0 ? hi : prefix),
            hi.byteLength > 0 ? hi.byteLength : prefix.byteLength,
            ptr(buf), outLen, outCount,
          );
          if (rc2 !== 0) throw `lsm_bridge_scan phase 2 returned ${rc2}`;
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
        },
        catch: (cause) => fail("scan", cause),
      }),
    ).pipe(Stream.flatMap((entries) => Stream.fromIterable(entries)));
  },

  putBatch: (entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>) =>
    Effect.try({
      try: () => {
        for (const { key, value } of entries) {
          const rc = ffi.lsm_bridge_put(ptr(key), key.byteLength, ptr(value), value.byteLength);
          if (rc !== 0) throw `lsm_bridge_put returned ${rc}`;
        }
      },
      catch: (cause) => fail("putBatch", cause),
    }),

  deleteBatch: (keys: ReadonlyArray<Uint8Array>) =>
    Effect.try({
      try: () => {
        for (const key of keys) {
          const rc = ffi.lsm_bridge_delete(ptr(key), key.byteLength);
          if (rc !== 0) throw `lsm_bridge_delete returned ${rc}`;
        }
      },
      catch: (cause) => fail("deleteBatch", cause),
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
      const initResult = ffi.lsm_bridge_init(ptr(pathBytes), pathBytes.byteLength);
      if (initResult !== 0) {
        return yield* Effect.fail(fail("init", `lsm_bridge_init returned ${initResult}`));
      }

      return makeBlobStoreOps(ffi);
    }),
  );

/**
 * BlobStore layer from an existing V2LSM snapshot.
 * Opens a session at sessionDir and restores a table from snapshotName.
 * @param sessionDir Path to the LSM session directory (containing snapshots/)
 * @param snapshotName Name of the snapshot to restore
 */
export const layerLsmFromSnapshot = (sessionDir: string, snapshotName: string) =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const libPath = yield* LsmBridgePath;
      const ffi = dlopen(libPath, BRIDGE_SYMBOLS).symbols;

      const pathBytes = new TextEncoder().encode(sessionDir);
      const nameBytes = new TextEncoder().encode(snapshotName);
      const initResult = ffi.lsm_bridge_init_from_snapshot(
        ptr(pathBytes), pathBytes.byteLength,
        ptr(nameBytes), nameBytes.byteLength,
      );
      if (initResult !== 0) {
        return yield* Effect.fail(
          fail("init_from_snapshot", `lsm_bridge_init_from_snapshot returned ${initResult}`),
        );
      }

      return makeBlobStoreOps(ffi);
    }),
  );
