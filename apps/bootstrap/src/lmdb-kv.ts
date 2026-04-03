/**
 * LMDB key-value streaming and discovery.
 */
import { Effect, Stream, Schema } from "effect"
import { LmdbError } from "./errors.ts"

const isByteLength = (n: number) =>
  Schema.makeFilter<Uint8Array>(
    (bytes) => bytes.length === n || `expected ${n} bytes, got ${bytes.length}`,
    { expected: `Uint8Array of exactly ${n} bytes` },
  )
import {
  openEnv, beginTxn, openDbi, openCursor, cursorGetSync,
  openLmdbSessionSync, closeLmdbSessionSync, discoverDatabases,
  MDB_FIRST, MDB_NEXT,
} from "./lmdb.ts"

export const UtxoKeySchema = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(34)),
)

function* cursorIterator(
  cursor: import("./lmdb.ts").LmdbCursor,
): IterableIterator<{ readonly key: Uint8Array; readonly value: Uint8Array }> {
  let entry = cursorGetSync(cursor, MDB_FIRST)
  while (entry !== undefined) {
    yield entry
    entry = cursorGetSync(cursor, MDB_NEXT)
  }
}

export const iterateEntries = (
  dbDir: string,
  dbName: string,
): Stream.Stream<{ readonly key: Uint8Array; readonly value: Uint8Array }, LmdbError> => {
  const session = openLmdbSessionSync(dbDir, dbName)
  return Stream.fromIteratorSucceed(cursorIterator(session.cursor)).pipe(
    Stream.ensuring(Effect.sync(() => closeLmdbSessionSync(session))),
  )
}

export const discoverLmdbDatabases = (dbDir: string): Effect.Effect<ReadonlyArray<string>, LmdbError> =>
  Effect.scoped(
    Effect.gen(function*() {
      const env = yield* openEnv(dbDir)
      const txn = yield* beginTxn(env, true)
      return yield* discoverDatabases(txn)
    })
  )
