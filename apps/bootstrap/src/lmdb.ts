/**
 * LMDB FFI bindings for Bun.
 * Wraps liblmdb operations in Effect with acquireRelease for resource safety.
 */
import { dlopen, FFIType, ptr, toArrayBuffer, CString, type Pointer } from "bun:ffi";
import { Effect, Schema, Scope } from "effect";
import { LmdbError } from "./errors.ts";

const NativePointer = Schema.Number.pipe(
  Schema.check(
    Schema.makeFilter<number>((n) => n !== 0 || "null pointer", {
      expected: "non-null native pointer",
    }),
  ),
);

function toPointer(n: number): Pointer {
  Schema.decodeSync(NativePointer)(n);
  return n as never;
}

// ---------------------------------------------------------------------------
// FFI library loading
// ---------------------------------------------------------------------------

const LMDB_LIB_PATH =
  process.env["LIBLMDB_PATH"] ??
  "/nix/store/3nx9lw1xvaj6byw6nii6rifgccfj7mcp-lmdb-0.9.35/lib/liblmdb.so";

const lib = dlopen(LMDB_LIB_PATH, {
  mdb_env_create: { args: [FFIType.ptr], returns: FFIType.int },
  mdb_env_set_mapsize: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.int },
  mdb_env_set_maxdbs: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.int },
  mdb_env_open: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32],
    returns: FFIType.int,
  },
  mdb_env_close: { args: [FFIType.ptr], returns: FFIType.void },
  mdb_txn_begin: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.int,
  },
  mdb_txn_abort: { args: [FFIType.ptr], returns: FFIType.void },
  mdb_dbi_open: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.int,
  },
  mdb_cursor_open: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.int },
  mdb_cursor_close: { args: [FFIType.ptr], returns: FFIType.void },
  mdb_cursor_get: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.int,
  },
  mdb_strerror: { args: [FFIType.int], returns: FFIType.ptr },
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MDB_RDONLY = 0x20000;
const MDB_NOTLS = 0x200000;
const MDB_NOLOCK = 0x400000;
export const MDB_FIRST = 0;
export const MDB_NEXT = 8;
const MDB_SUCCESS = 0;
const MDB_NOTFOUND = -30798;

// ---------------------------------------------------------------------------
// MDB_val helpers (16 bytes on 64-bit: 8-byte size + 8-byte pointer, LE)
// ---------------------------------------------------------------------------

const MDB_VAL_SIZE = 16;

function mdbError(rc: number): string {
  const strPtr = lib.symbols.mdb_strerror(rc);
  return strPtr ? `${new CString(strPtr as never)} (${rc})` : `LMDB error ${rc}`;
}

function check(rc: number, operation: string): void {
  if (rc !== MDB_SUCCESS) {
    throw new LmdbError({ operation, cause: mdbError(rc) });
  }
}

function readMdbValData(valBuf: Uint8Array, offset: number): Uint8Array {
  const dv = new DataView(valBuf.buffer, valBuf.byteOffset + offset);
  const size = Number(dv.getBigUint64(0, true));
  const dataPtr = Number(dv.getBigUint64(8, true));
  if (size === 0 || dataPtr === 0) return new Uint8Array(0);
  return new Uint8Array(toArrayBuffer(toPointer(dataPtr), 0, size)).slice();
}

// ---------------------------------------------------------------------------
// Resource handles
// ---------------------------------------------------------------------------

export interface LmdbEnv {
  readonly envPtr: number;
}
export interface LmdbTxn {
  readonly txnPtr: number;
}
export interface LmdbCursor {
  readonly cursorPtr: number;
  readonly keyBuf: Uint8Array;
  readonly dataBuf: Uint8Array;
}

// ---------------------------------------------------------------------------
// Effect-wrapped lifecycle operations
// ---------------------------------------------------------------------------

export const openEnv = (
  dbDir: string,
  opts?: { readonly mapSize?: number; readonly maxDbs?: number },
): Effect.Effect<LmdbEnv, LmdbError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const envPtrBuf = new BigUint64Array(1);
        check(lib.symbols.mdb_env_create(ptr(envPtrBuf)), "mdb_env_create");
        const envPtr = Number(envPtrBuf[0]!);
        check(
          lib.symbols.mdb_env_set_mapsize(
            toPointer(envPtr),
            BigInt(opts?.mapSize ?? 2 * 1024 * 1024 * 1024),
          ),
          "mdb_env_set_mapsize",
        );
        check(
          lib.symbols.mdb_env_set_maxdbs(toPointer(envPtr), opts?.maxDbs ?? 10),
          "mdb_env_set_maxdbs",
        );
        const pathBuf = Buffer.from(dbDir + "\0", "utf-8");
        check(
          lib.symbols.mdb_env_open(
            toPointer(envPtr),
            ptr(pathBuf),
            MDB_RDONLY | MDB_NOTLS | MDB_NOLOCK,
            0o644,
          ),
          "mdb_env_open",
        );
        return { envPtr } as const;
      },
      catch: (e) =>
        e instanceof LmdbError ? e : new LmdbError({ operation: "openEnv", cause: e }),
    }),
    (env) => Effect.sync(() => lib.symbols.mdb_env_close(toPointer(env.envPtr))),
  );

export const beginTxn = (
  env: LmdbEnv,
  readOnly: boolean,
): Effect.Effect<LmdbTxn, LmdbError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const txnPtrBuf = new BigUint64Array(1);
        const flags = readOnly ? MDB_RDONLY : 0;
        check(
          lib.symbols.mdb_txn_begin(toPointer(env.envPtr), null, flags, ptr(txnPtrBuf)),
          "mdb_txn_begin",
        );
        return { txnPtr: Number(txnPtrBuf[0]!) } as const;
      },
      catch: (e) =>
        e instanceof LmdbError ? e : new LmdbError({ operation: "beginTxn", cause: e }),
    }),
    (txn) => Effect.sync(() => lib.symbols.mdb_txn_abort(toPointer(txn.txnPtr))),
  );

export const openDbi = (txn: LmdbTxn, name: string | null): Effect.Effect<number, LmdbError> =>
  Effect.try({
    try: () => {
      const dbiBuf = new Uint32Array(1);
      if (name === null) {
        check(
          lib.symbols.mdb_dbi_open(toPointer(txn.txnPtr), null, 0, ptr(dbiBuf)),
          "mdb_dbi_open(root)",
        );
      } else {
        const nameBuf = Buffer.from(name + "\0", "utf-8");
        check(
          lib.symbols.mdb_dbi_open(toPointer(txn.txnPtr), ptr(nameBuf), 0, ptr(dbiBuf)),
          `mdb_dbi_open(${name})`,
        );
      }
      return dbiBuf[0]!;
    },
    catch: (e) => (e instanceof LmdbError ? e : new LmdbError({ operation: "openDbi", cause: e })),
  });

export const openCursor = (
  txn: LmdbTxn,
  dbi: number,
): Effect.Effect<LmdbCursor, LmdbError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const cursorPtrBuf = new BigUint64Array(1);
        check(
          lib.symbols.mdb_cursor_open(toPointer(txn.txnPtr), dbi, ptr(cursorPtrBuf)),
          "mdb_cursor_open",
        );
        return {
          cursorPtr: Number(cursorPtrBuf[0]!),
          keyBuf: new Uint8Array(MDB_VAL_SIZE),
          dataBuf: new Uint8Array(MDB_VAL_SIZE),
        } as const;
      },
      catch: (e) =>
        e instanceof LmdbError ? e : new LmdbError({ operation: "openCursor", cause: e }),
    }),
    (cursor) => Effect.sync(() => lib.symbols.mdb_cursor_close(toPointer(cursor.cursorPtr))),
  );

export const cursorGet = (
  cursor: LmdbCursor,
  op: number,
): Effect.Effect<{ readonly key: Uint8Array; readonly value: Uint8Array } | undefined, LmdbError> =>
  Effect.try({
    try: () => {
      const rc = lib.symbols.mdb_cursor_get(
        toPointer(cursor.cursorPtr),
        ptr(cursor.keyBuf),
        ptr(cursor.dataBuf),
        op,
      );
      if (rc === MDB_NOTFOUND) return undefined;
      if (rc !== MDB_SUCCESS)
        throw new LmdbError({ operation: "mdb_cursor_get", cause: mdbError(rc) });
      return {
        key: readMdbValData(cursor.keyBuf, 0),
        value: readMdbValData(cursor.dataBuf, 0),
      } as const;
    },
    catch: (e) =>
      e instanceof LmdbError ? e : new LmdbError({ operation: "cursorGet", cause: e }),
  });

// ---------------------------------------------------------------------------
// Synchronous lifecycle (for iterator-based streaming without Effect scope)
// ---------------------------------------------------------------------------

export interface LmdbSession {
  readonly envPtr: number;
  readonly txnPtr: number;
  readonly cursor: LmdbCursor;
}

export function openLmdbSessionSync(
  dbDir: string,
  dbName: string,
  opts?: { readonly mapSize?: number; readonly maxDbs?: number },
): LmdbSession {
  const envPtrBuf = new BigUint64Array(1);
  check(lib.symbols.mdb_env_create(ptr(envPtrBuf)), "mdb_env_create");
  const envPtr = Number(envPtrBuf[0]!);

  check(
    lib.symbols.mdb_env_set_mapsize(
      toPointer(envPtr),
      BigInt(opts?.mapSize ?? 2 * 1024 * 1024 * 1024),
    ),
    "mdb_env_set_mapsize",
  );
  check(
    lib.symbols.mdb_env_set_maxdbs(toPointer(envPtr), opts?.maxDbs ?? 10),
    "mdb_env_set_maxdbs",
  );

  const pathBuf = Buffer.from(dbDir + "\0", "utf-8");
  check(
    lib.symbols.mdb_env_open(
      toPointer(envPtr),
      ptr(pathBuf),
      MDB_RDONLY | MDB_NOTLS | MDB_NOLOCK,
      0o644,
    ),
    "mdb_env_open",
  );

  const txnPtrBuf = new BigUint64Array(1);
  check(
    lib.symbols.mdb_txn_begin(toPointer(envPtr), null, MDB_RDONLY, ptr(txnPtrBuf)),
    "mdb_txn_begin",
  );
  const txnPtr = Number(txnPtrBuf[0]!);

  const dbiBuf = new Uint32Array(1);
  const nameBuf = Buffer.from(dbName + "\0", "utf-8");
  check(
    lib.symbols.mdb_dbi_open(toPointer(txnPtr), ptr(nameBuf), 0, ptr(dbiBuf)),
    `mdb_dbi_open(${dbName})`,
  );
  const dbi = dbiBuf[0]!;

  const cursorPtrBuf = new BigUint64Array(1);
  check(lib.symbols.mdb_cursor_open(toPointer(txnPtr), dbi, ptr(cursorPtrBuf)), "mdb_cursor_open");

  return {
    envPtr,
    txnPtr,
    cursor: {
      cursorPtr: Number(cursorPtrBuf[0]!),
      keyBuf: new Uint8Array(MDB_VAL_SIZE),
      dataBuf: new Uint8Array(MDB_VAL_SIZE),
    },
  };
}

export function closeLmdbSessionSync(session: LmdbSession): void {
  lib.symbols.mdb_cursor_close(toPointer(session.cursor.cursorPtr));
  lib.symbols.mdb_txn_abort(toPointer(session.txnPtr));
  lib.symbols.mdb_env_close(toPointer(session.envPtr));
}

export function cursorGetSync(
  cursor: LmdbCursor,
  op: number,
): { readonly key: Uint8Array; readonly value: Uint8Array } | undefined {
  const rc = lib.symbols.mdb_cursor_get(
    toPointer(cursor.cursorPtr),
    ptr(cursor.keyBuf),
    ptr(cursor.dataBuf),
    op,
  );
  if (rc === MDB_NOTFOUND) return undefined;
  if (rc !== MDB_SUCCESS) throw new LmdbError({ operation: "mdb_cursor_get", cause: mdbError(rc) });
  return {
    key: readMdbValData(cursor.keyBuf, 0),
    value: readMdbValData(cursor.dataBuf, 0),
  };
}

// ---------------------------------------------------------------------------
// Discover sub-database names from the root (unnamed) database
// ---------------------------------------------------------------------------

export const discoverDatabases = (
  txn: LmdbTxn,
): Effect.Effect<ReadonlyArray<string>, LmdbError, Scope.Scope> =>
  openDbi(txn, null).pipe(
    Effect.flatMap((rootDbi) =>
      openCursor(txn, rootDbi).pipe(
        Effect.flatMap((cursor) =>
          Effect.try({
            try: () => {
              const names: string[] = [];
              let rc = lib.symbols.mdb_cursor_get(
                toPointer(cursor.cursorPtr),
                ptr(cursor.keyBuf),
                ptr(cursor.dataBuf),
                MDB_FIRST,
              );
              while (rc === MDB_SUCCESS) {
                names.push(new TextDecoder().decode(readMdbValData(cursor.keyBuf, 0)));
                rc = lib.symbols.mdb_cursor_get(
                  toPointer(cursor.cursorPtr),
                  ptr(cursor.keyBuf),
                  ptr(cursor.dataBuf),
                  MDB_NEXT,
                );
              }
              return names;
            },
            catch: (e) =>
              e instanceof LmdbError
                ? e
                : new LmdbError({ operation: "discoverDatabases", cause: e }),
          }),
        ),
      ),
    ),
  );
