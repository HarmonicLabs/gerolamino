/**
 * Import LMDB UTxO data into a BlobStore (LSM) session.
 * One-time migration tool — reads all LMDB entries via liblmdb FFI
 * and writes them through BlobStore.putBatch.
 *
 * Requires LIBLMDB_PATH env var for liblmdb.so.
 */
import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { Effect, Stream } from "effect";
import { BlobStore, BlobStoreError } from "storage/blob-store/service";
import { utxoKey } from "storage/blob-store/keys";

// Minimal LMDB FFI — just enough to iterate entries
const LMDB_SYMBOLS = {
  mdb_env_create: { args: [FFIType.ptr], returns: FFIType.int },
  mdb_env_set_mapsize: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.int },
  mdb_env_set_maxdbs: { args: [FFIType.ptr, FFIType.int], returns: FFIType.int },
  mdb_env_open: { args: [FFIType.ptr, FFIType.ptr, FFIType.int, FFIType.int], returns: FFIType.int },
  mdb_txn_begin: { args: [FFIType.ptr, FFIType.ptr, FFIType.int, FFIType.ptr], returns: FFIType.int },
  mdb_txn_abort: { args: [FFIType.ptr], returns: FFIType.void },
  mdb_dbi_open: { args: [FFIType.ptr, FFIType.ptr, FFIType.int, FFIType.ptr], returns: FFIType.int },
  mdb_cursor_open: { args: [FFIType.ptr, FFIType.int, FFIType.ptr], returns: FFIType.int },
  mdb_cursor_get: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.int], returns: FFIType.int },
  mdb_cursor_close: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

const MDB_RDONLY = 0x20000;
const MDB_NOTLS = 0x200000;
const MDB_NOLOCK = 0x400000;
const MDB_FIRST = 0;
const MDB_NEXT = 8;
const MDB_NOTFOUND = -30798;

function numToPtr(n: number): Pointer {
  return n as never;
}

/** Read an MDB_val (size + data ptr) from a 16-byte buffer. */
function readMdbVal(buf: Uint8Array): Uint8Array {
  const view = new DataView(buf.buffer, buf.byteOffset);
  const size = Number(view.getBigUint64(0, true)); // little-endian size
  const dataPtr = Number(view.getBigUint64(8, true)); // little-endian ptr
  if (size === 0 || dataPtr === 0) return new Uint8Array(0);
  return new Uint8Array(toArrayBuffer(numToPtr(dataPtr), 0, size)).slice();
}

const cstr = (s: string): Uint8Array => {
  const enc = new TextEncoder();
  const buf = new Uint8Array(enc.encode(s).length + 1);
  enc.encodeInto(s, buf);
  return buf;
};

/**
 * Import all UTxO entries from an LMDB database into BlobStore.
 * @param lmdbLibPath Path to liblmdb.so
 * @param tablesDir Path to LMDB tables directory (containing data.mdb)
 */
export const importLmdbToBlob = (
  lmdbLibPath: string,
  tablesDir: string,
) =>
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const lib = dlopen(lmdbLibPath, LMDB_SYMBOLS).symbols;

    // Open LMDB environment
    const envBuf = new BigUint64Array(1);
    lib.mdb_env_create(envBuf);
    const envPtr = numToPtr(Number(envBuf[0]));
    lib.mdb_env_set_mapsize(envPtr, 2n * 1024n * 1024n * 1024n); // 2GB
    lib.mdb_env_set_maxdbs(envPtr, 10);
    const openResult = lib.mdb_env_open(
      envPtr,
      ptr(cstr(tablesDir)),
      MDB_RDONLY | MDB_NOTLS | MDB_NOLOCK,
      0o644,
    );
    if (openResult !== 0) {
      return yield* Effect.fail(
        new BlobStoreError({ operation: "importLmdb", cause: `mdb_env_open returned ${openResult}` }),
      );
    }

    // Begin read-only transaction
    const txnBuf = new BigUint64Array(1);
    lib.mdb_txn_begin(envPtr, null, MDB_RDONLY, txnBuf);
    const txnPtr = numToPtr(Number(txnBuf[0]));

    // Open "utxo" database
    const dbiBuf = new Uint32Array(1);
    const dbiResult = lib.mdb_dbi_open(txnPtr, ptr(cstr("utxo")), 0, ptr(dbiBuf));
    if (dbiResult !== 0) {
      lib.mdb_txn_abort(txnPtr);
      return yield* Effect.fail(
        new BlobStoreError({ operation: "importLmdb", cause: `mdb_dbi_open returned ${dbiResult}` }),
      );
    }
    const dbi = dbiBuf[0]!;

    // Open cursor and iterate
    const cursorBuf = new BigUint64Array(1);
    lib.mdb_cursor_open(txnPtr, dbi, cursorBuf);
    const cursorPtr = numToPtr(Number(cursorBuf[0]));

    const keyBuf = new Uint8Array(16);
    const valBuf = new Uint8Array(16);
    let batch: Array<{ key: Uint8Array; value: Uint8Array }> = [];
    let total = 0;

    let rc = lib.mdb_cursor_get(cursorPtr, ptr(keyBuf), ptr(valBuf), MDB_FIRST);
    while (rc === 0) {
      const key = readMdbVal(keyBuf);
      const value = readMdbVal(valBuf);
      batch.push({ key: utxoKey(key), value });
      total++;

      if (batch.length >= 1000) {
        yield* store.putBatch(batch);
        batch = [];
        if (total % 100_000 === 0) {
          yield* Effect.log(`  Imported ${total} entries...`);
        }
      }

      rc = lib.mdb_cursor_get(cursorPtr, ptr(keyBuf), ptr(valBuf), MDB_NEXT);
    }

    if (batch.length > 0) {
      yield* store.putBatch(batch);
    }

    lib.mdb_cursor_close(cursorPtr);
    lib.mdb_txn_abort(txnPtr);

    yield* Effect.log(`Imported ${total} UTxO entries from LMDB to BlobStore`);
    return total;
  });
