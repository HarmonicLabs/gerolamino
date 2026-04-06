/**
 * BlobStore layer backed by lsm-tree via Bun FFI.
 *
 * Loads liblsm-ffi.so (Haskell foreign-library) and calls C-exported
 * functions: lsm_session_open, lsm_insert, lsm_lookup, lsm_delete, etc.
 *
 * Used by Bun TUI and bootstrap server for reading V2LSM snapshots.
 */
import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { Effect, Layer, Stream } from "effect";
import { BlobStore, BlobStoreError } from "storage/blob-store/service";
import type { BlobStoreShape } from "storage/blob-store/service";

// ---------------------------------------------------------------------------
// FFI pointer helpers
// ---------------------------------------------------------------------------

/**
 * Convert a numeric address (from a C out-parameter) to a Bun FFI Pointer.
 * This is the standard pattern at the FFI boundary — Bun's type system
 * models Pointer as an opaque brand, but at runtime it's a number.
 * See apps/bootstrap/src/lmdb.ts toPointer() for the established pattern.
 */
function numToPtr(n: number): Pointer {
  if (n === 0) throw new Error("null pointer");
  // Bun FFI Pointer is a branded number at runtime
  return n as never;
}

/** Read a pointer value from a BigUint64Array out-parameter. */
function readHandle(buf: BigUint64Array): Pointer {
  return numToPtr(Number(buf[0]));
}

// ---------------------------------------------------------------------------
// FFI symbol definitions
// ---------------------------------------------------------------------------

const FFI_SYMBOLS = {
  lsm_session_open: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.int,
  },
  lsm_session_close: {
    args: [FFIType.ptr],
    returns: FFIType.int,
  },
  lsm_table_new: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.int,
  },
  lsm_table_close: {
    args: [FFIType.ptr],
    returns: FFIType.int,
  },
  lsm_insert: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_lookup: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
    returns: FFIType.int,
  },
  lsm_delete: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.int,
  },
  lsm_snapshot_save: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.int,
  },
} as const;

type LsmLib = ReturnType<typeof dlopen<typeof FFI_SYMBOLS>>["symbols"];

const fail = (operation: string, cause: unknown) =>
  new BlobStoreError({ operation, cause });

/** Encode a string as a null-terminated C string. */
const cstr = (s: string): Uint8Array => {
  const enc = new TextEncoder();
  const buf = new Uint8Array(enc.encode(s).length + 1);
  enc.encodeInto(s, buf);
  return buf;
};

// ---------------------------------------------------------------------------
// BlobStore shape implementation
// ---------------------------------------------------------------------------

const makeShape = (
  ffi: LsmLib,
  tableHandle: Pointer,
): BlobStoreShape => ({
  get: (key) =>
    Effect.try({
      try: () => {
        const outBufPtr = new BigUint64Array(1);
        const outLenPtr = new BigUint64Array(1);
        const result = ffi.lsm_lookup(
          tableHandle,
          ptr(key),
          key.byteLength,
          outBufPtr,
          outLenPtr,
        );
        if (result === 1) return undefined; // not found
        if (result !== 0) throw `lsm_lookup returned ${result}`;
        const len = Number(outLenPtr[0]);
        const valPtr = readHandle(outBufPtr);
        // Copy from GHC-managed memory to JS-owned buffer before next GC
        return new Uint8Array(toArrayBuffer(valPtr, 0, len)).slice();
      },
      catch: (cause) => fail("get", cause),
    }),

  put: (key, value) =>
    Effect.try({
      try: () => {
        const result = ffi.lsm_insert(
          tableHandle,
          ptr(key),
          key.byteLength,
          ptr(value),
          value.byteLength,
        );
        if (result !== 0) throw `lsm_insert returned ${result}`;
      },
      catch: (cause) => fail("put", cause),
    }),

  delete: (key) =>
    Effect.try({
      try: () => {
        const result = ffi.lsm_delete(tableHandle, ptr(key), key.byteLength);
        if (result !== 0) throw `lsm_delete returned ${result}`;
      },
      catch: (cause) => fail("delete", cause),
    }),

  has: (key) =>
    Effect.try({
      try: () => {
        const outBufPtr = new BigUint64Array(1);
        const outLenPtr = new BigUint64Array(1);
        const result = ffi.lsm_lookup(
          tableHandle,
          ptr(key),
          key.byteLength,
          outBufPtr,
          outLenPtr,
        );
        return result === 0;
      },
      catch: (cause) => fail("has", cause),
    }),

  scan: (_prefix) =>
    // TODO: cursor-based range scan via lsm_cursor_open/next FFI
    Stream.fail(fail("scan", "cursor FFI not yet implemented")),

  putBatch: (entries) =>
    Effect.try({
      try: () => {
        for (const { key, value } of entries) {
          const result = ffi.lsm_insert(
            tableHandle,
            ptr(key),
            key.byteLength,
            ptr(value),
            value.byteLength,
          );
          if (result !== 0) throw `lsm_insert returned ${result}`;
        }
      },
      catch: (cause) => fail("putBatch", cause),
    }),

  deleteBatch: (keys) =>
    Effect.try({
      try: () => {
        for (const key of keys) {
          const result = ffi.lsm_delete(tableHandle, ptr(key), key.byteLength);
          if (result !== 0) throw `lsm_delete returned ${result}`;
        }
      },
      catch: (cause) => fail("deleteBatch", cause),
    }),
});

// ---------------------------------------------------------------------------
// Layer constructor
// ---------------------------------------------------------------------------

/**
 * BlobStore layer backed by lsm-tree native .so via Bun FFI.
 * @param libPath Path to liblsm-ffi.so
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
        const ffi = dlopen(libPath, FFI_SYMBOLS).symbols;

        // Open session
        const sessionBuf = new BigUint64Array(1);
        const sessionResult = ffi.lsm_session_open(ptr(cstr(dataDir)), sessionBuf);
        if (sessionResult !== 0) throw `session_open returned ${sessionResult}`;
        const sessionHandle = readHandle(sessionBuf);

        // Create table
        const tableBuf = new BigUint64Array(1);
        const tableResult = ffi.lsm_table_new(sessionHandle, tableBuf);
        if (tableResult !== 0) throw `table_new returned ${tableResult}`;
        const tableHandle = readHandle(tableBuf);

        return makeShape(ffi, tableHandle) as never;
      },
      catch: (cause) => fail("layerLsm", cause),
    }),
  );
