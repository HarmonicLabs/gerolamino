/**
 * Drizzle query-builder + Effect SqlClient bridge.
 *
 * The schema in `../schema/` is the TypeScript source of truth for
 * tables and column types; we use it through Drizzle's lexical query
 * builders (`.select()`, `.insert()`, `.update()`, `.delete()`) to
 * construct parameterised SQL, then hand the `{ sql, params }` pair to
 * the abstract `SqlClient.unsafe` for execution.
 *
 * Why this is driver-free:
 *
 *   - Drizzle's `BaseSQLiteDatabase` requires a `SQLiteSession` to
 *     construct, but `.toSQL()` only walks the `dialect` — it never
 *     touches the session. We provide a stub session whose abstract
 *     methods throw, so any accidental `.execute()` / `.run()` use is
 *     caught loudly at runtime.
 *   - All imports stay on `drizzle-orm/sqlite-core` (the dialect-
 *     abstract surface). No `drizzle-orm/bun-sqlite` or
 *     `drizzle-orm/sqlite-wasm` driver imports — the abstraction-
 *     boundary rule keeps this package executable on either backend.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Statement } from "effect/unstable/sql/Statement";
import { BaseSQLiteDatabase, SQLiteSession, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

const fail = (): never => {
  throw new Error(
    "[storage/drizzle] Query builders are lexical-only — call `.toSQL()` and pass the result to `exec`/`SqlClient.unsafe` instead of executing on the Drizzle db.",
  );
};

class LexicalOnlySession extends SQLiteSession<"sync", void> {
  prepareQuery() {
    return fail();
  }
  prepareRelationalQuery() {
    return fail();
  }
  transaction() {
    return fail();
  }
}

const dialect = new SQLiteSyncDialect();

/**
 * Lexical-only Drizzle DB. Use the standard query-builder methods
 * (`.select()`, `.insert(table)`, `.update(table)`, `.delete(table)`)
 * and pass the result to {@link exec}. Never call `.execute()` /
 * `.run()` / `.all()` directly — they hit the stub session and throw.
 */
export const db = new BaseSQLiteDatabase(
  "sync",
  dialect,
  new LexicalOnlySession(dialect),
  {},
  undefined,
);

interface ToSql {
  toSQL(): { readonly sql: string; readonly params: ReadonlyArray<unknown> };
}

/**
 * Compile a Drizzle query into a `Statement` against an already-acquired
 * `SqlClient`. Used inside `Effect.gen` blocks that already have the
 * client in scope, especially around `SqlSchema.findOneOption` and
 * `sql.withTransaction(...)` where adding another `yield* SqlClient`
 * would fight the existing pattern.
 */
export const compile = <A extends object = Record<string, unknown>>(
  client: SqlClient,
  query: ToSql,
): Statement<A> => {
  const { sql, params } = query.toSQL();
  return client.unsafe<A>(sql, params);
};

/**
 * Execute a Drizzle query through the abstract `SqlClient` in one shot.
 * Convenience wrapper for sites that don't need `withTransaction` or
 * `findOneOption` plumbing — e.g. a single bulk insert or delete.
 */
export const exec = <A extends object = Record<string, unknown>>(query: ToSql) =>
  Effect.gen(function* () {
    const client = yield* SqlClient;
    return yield* compile<A>(client, query);
  });
