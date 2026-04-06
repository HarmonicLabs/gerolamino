/**
 * BlobStore layer backed by lsm-tree via Zig bridge.
 *
 * The Zig bridge (liblsm-bridge.so) wraps the Haskell lsm-ffi exports
 * with a buffer-based API. No raw pointer handling — TypeScript passes
 * Uint8Array buffers, Zig copies data in/out.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { Effect, Layer, Stream } from "effect";
import { BlobStore, BlobStoreError } from "storage/blob-store/service";
import { prefixEnd } from "storage/blob-store/keys";

const BRIDGE_SYMBOLS = {
  lsm_bridge_init: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_bridge_put: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  // get: key_ptr, key_len, out_buf (nullable), out_capacity, out_len_ptr
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

/** Pre-allocated reusable length buffer for get operations. */
const lenBuf = new BigUint64Array(1);

/**
 * Get a value from LSM. Two-phase: first call gets length, second copies data.
 * All data is copied into JS-owned Uint8Arrays — no pointer lifecycle management.
 */
const lsmGet = (ffi: BridgeLib, key: Uint8Array): Uint8Array | undefined => {
  // Phase 1: get the value length (pass null buffer, capacity 0)
  lenBuf[0] = 0n;
  const rc1 = ffi.lsm_bridge_get(ptr(key), key.byteLength, null, 0, lenBuf);
  if (rc1 === 1) return undefined; // not found
  if (rc1 !== 0) throw `lsm_bridge_get phase 1 returned ${rc1}`;

  const len = Number(lenBuf[0]);
  if (len === 0) return new Uint8Array(0);

  // Phase 2: copy value into JS-owned buffer
  const outBuf = new Uint8Array(len);
  lenBuf[0] = 0n;
  const rc2 = ffi.lsm_bridge_get(ptr(key), key.byteLength, ptr(outBuf), len, lenBuf);
  if (rc2 !== 0) throw `lsm_bridge_get phase 2 returned ${rc2}`;

  return outBuf;
};

/**
 * BlobStore layer backed by lsm-tree via Zig bridge.
 * @param libPath Path to liblsm-bridge.so
 * @param dataDir Path to LSM data directory
 */
export const layerLsm = (
  libPath: string,
  dataDir: string,
): Layer.Layer<BlobStore, BlobStoreError> =>
  Layer.effect(
    BlobStore,
    Effect.try({
      try: () => {
        const ffi = dlopen(libPath, BRIDGE_SYMBOLS).symbols;

        // Initialize: GHC RTS + LSM session + table
        const pathBytes = new TextEncoder().encode(dataDir);
        const initResult = ffi.lsm_bridge_init(ptr(pathBytes), pathBytes.byteLength);
        if (initResult !== 0) throw `lsm_bridge_init returned ${initResult}`;

        return {
          get: (key: Uint8Array) =>
            Effect.try({
              try: () => lsmGet(ffi, key),
              catch: (cause) => fail("get", cause),
            }),

          put: (key: Uint8Array, value: Uint8Array) =>
            Effect.try({
              try: () => {
                const result = ffi.lsm_bridge_put(
                  ptr(key), key.byteLength, ptr(value), value.byteLength,
                );
                if (result !== 0) throw `lsm_bridge_put returned ${result}`;
              },
              catch: (cause) => fail("put", cause),
            }),

          delete: (key: Uint8Array) =>
            Effect.try({
              try: () => {
                const result = ffi.lsm_bridge_delete(ptr(key), key.byteLength);
                if (result !== 0) throw `lsm_bridge_delete returned ${result}`;
              },
              catch: (cause) => fail("delete", cause),
            }),

          has: (key: Uint8Array) =>
            Effect.try({
              try: () => {
                lenBuf[0] = 0n;
                const result = ffi.lsm_bridge_get(
                  ptr(key), key.byteLength, null, 0, lenBuf,
                );
                return result === 0;
              },
              catch: (cause) => fail("has", cause),
            }),

          scan: (prefix: Uint8Array) => {
            const hi = prefixEnd(prefix);
            return Stream.fromEffect(
              Effect.try({
                try: () => {
                  const outPtr = new BigUint64Array(1);
                  const outLen = new BigUint64Array(1);
                  const outCount = new BigUint64Array(1);
                  const result = ffi.lsm_bridge_scan(
                    ptr(prefix), prefix.byteLength,
                    ptr(hi.byteLength > 0 ? hi : prefix),
                    hi.byteLength > 0 ? hi.byteLength : prefix.byteLength,
                    outPtr, outLen, outCount,
                  );
                  if (result !== 0) throw `lsm_bridge_scan returned ${result}`;
                  const count = Number(outCount[0]);
                  if (count === 0) {
                    const empty: Array<{ key: Uint8Array; value: Uint8Array }> = [];
                    return empty;
                  }
                  // scan still uses the Haskell-allocated flat buffer via lsm_range_lookup
                  // TODO: migrate scan to caller-provided buffer pattern once cursor FFI is added
                  const totalLen = Number(outLen[0]);
                  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
                  // For now, parse from the returned buffer addresses
                  // This is the one remaining area that touches raw memory
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
                  const result = ffi.lsm_bridge_put(
                    ptr(key), key.byteLength, ptr(value), value.byteLength,
                  );
                  if (result !== 0) throw `lsm_bridge_put returned ${result}`;
                }
              },
              catch: (cause) => fail("putBatch", cause),
            }),

          deleteBatch: (keys: ReadonlyArray<Uint8Array>) =>
            Effect.try({
              try: () => {
                for (const key of keys) {
                  const result = ffi.lsm_bridge_delete(ptr(key), key.byteLength);
                  if (result !== 0) throw `lsm_bridge_delete returned ${result}`;
                }
              },
              catch: (cause) => fail("deleteBatch", cause),
            }),
        };
      },
      catch: (cause) => fail("layerLsm", cause),
    }),
  );
