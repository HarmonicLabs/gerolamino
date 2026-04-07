/**
 * Drizzle ORM ↔ Effect v4 beta SqlClient bridge.
 *
 * Two driver strategies:
 *
 * 1. **SqlClient proxy** (preferred — TUI, Chrome, any platform): Routes
 *    `drizzle-orm/sqlite-proxy` through Effect's abstract SqlClient.
 *    `layerBunSqlClient` wraps bun:sqlite as a Connection; `layerProxy`
 *    feeds it to Drizzle.  `runMigrations` shares the same SqlClient.
 *
 * 2. **Direct `bun:sqlite`** (`SqliteDrizzle.layerBun`): Zero proxy
 *    overhead — Drizzle talks to `bun:sqlite` synchronously.
 *    Does NOT provide SqlClient so cannot be used with runMigrations.
 *
 * Recommended TUI composition:
 *
 *   const sqlClient  = layerBunSqlClient({ filename: "chain.db" });
 *   const drizzle    = SqliteDrizzle.layerProxy.pipe(Layer.provide(sqlClient));
 *   // runMigrations consumes SqlClient; ChainDBLive consumes SqliteDrizzle + BlobStore
 */
import { Effect, Layer, Scope, ServiceMap, Stream } from "effect";
import { SqlClient, make as makeSqlClient } from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import { makeCompilerSqlite } from "effect/unstable/sql/Statement";
import { layer as ReactivityLayer } from "effect/unstable/reactivity/Reactivity";
import type { DrizzleConfig } from "drizzle-orm";
import { drizzle as drizzleProxy, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { drizzle as drizzleBun } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema.ts";

export { schema };

type DrizzleDB = SqliteRemoteDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// SqlClient layer for bun:sqlite — wraps synchronous API in Effect
// ---------------------------------------------------------------------------

const makeBunSqliteConnection = (db: Database): Connection => {
  const run = (sql: string, params: ReadonlyArray<unknown>) => {
    const stmt = db.query(sql);
    return (stmt.all(...params) ?? []) as ReadonlyArray<any>;
  };

  const runValues = (sql: string, params: ReadonlyArray<unknown>) => {
    const stmt = db.query(sql);
    return (stmt.values(...params) ?? []) as ReadonlyArray<ReadonlyArray<unknown>>;
  };

  return {
    execute: (sql, params, transformRows) =>
      Effect.try({
        try: () => {
          const rows = run(sql, params);
          return transformRows ? transformRows(rows) : rows;
        },
        catch: (cause) =>
          new SqlError({ reason: classifySqliteError(cause) }),
      }),
    executeRaw: (sql, params) =>
      Effect.try({
        try: () => run(sql, params),
        catch: (cause) =>
          new SqlError({ reason: classifySqliteError(cause) }),
      }),
    executeValues: (sql, params) =>
      Effect.try({
        try: () => runValues(sql, params),
        catch: (cause) =>
          new SqlError({ reason: classifySqliteError(cause) }),
      }),
    executeUnprepared: (sql, params, transformRows) =>
      Effect.try({
        try: () => {
          const rows = run(sql, params);
          return transformRows ? transformRows(rows) : rows;
        },
        catch: (cause) =>
          new SqlError({ reason: classifySqliteError(cause) }),
      }),
    executeStream: (sql, params, transformRows) =>
      Stream.fromEffect(
        Effect.try({
          try: () => {
            const rows = run(sql, params);
            return transformRows ? transformRows(rows) : rows;
          },
          catch: (cause) =>
            new SqlError({ reason: classifySqliteError(cause) }),
        }),
      ).pipe(Stream.flatMap((rows) => Stream.fromIterable(rows))),
  };
};

/**
 * Create an Effect SqlClient layer backed by bun:sqlite.
 * Provides SqlClient for use by runMigrations and SqliteDrizzle.layerProxy.
 */
export const layerBunSqlClient = (opts: { filename: string }): Layer.Layer<SqlClient> =>
  Layer.effect(
    SqlClient,
    Effect.gen(function* () {
      const db = new Database(opts.filename);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA foreign_keys = ON");
      yield* Scope.addFinalizer(yield* Effect.scope, Effect.sync(() => db.close()));
      const connection = makeBunSqliteConnection(db);
      const compiler = makeCompilerSqlite();
      return yield* makeSqlClient({
        acquirer: Effect.succeed(connection),
        compiler,
        spanAttributes: [["db.system", "sqlite"]],
      });
    }),
  ).pipe(Layer.provide(ReactivityLayer));

// ---------------------------------------------------------------------------
// SqliteDrizzle service
// ---------------------------------------------------------------------------

/**
 * SqliteDrizzle service — yield* this in Effect.gen to get a type-safe
 * Drizzle query builder. Works with either the Bun or proxy backend.
 */
export class SqliteDrizzle extends ServiceMap.Service<SqliteDrizzle, DrizzleDB>()(
  "@storage/SqliteDrizzle",
) {
  /**
   * Direct `bun:sqlite` layer — zero proxy overhead.
   * Use for TUI / server (Bun runtime only).
   */
  static layerBun = (opts: { filename: string }): Layer.Layer<SqliteDrizzle> =>
    Layer.effect(
      SqliteDrizzle,
      Effect.sync(() => {
        const sqlite = new Database(opts.filename);
        sqlite.exec("PRAGMA journal_mode = WAL");
        sqlite.exec("PRAGMA synchronous = NORMAL");
        sqlite.exec("PRAGMA foreign_keys = ON");
        return drizzleBun({ client: sqlite, schema }) as unknown as DrizzleDB;
      }),
    );

  /**
   * Proxy layer through Effect SqlClient — for cross-platform use.
   * Requires SqlClient in environment (WasmSqlite, etc.).
   */
  static layerProxy: Layer.Layer<SqliteDrizzle, never, SqlClient> = Layer.effect(
    SqliteDrizzle,
    makeProxyDrizzle(),
  );
}

/**
 * Layer alias for backward compatibility.
 */
export const layer = SqliteDrizzle.layerProxy;

// ---------------------------------------------------------------------------
// Proxy bridge — routes Drizzle SQL through Effect's abstract SqlClient
// ---------------------------------------------------------------------------

function makeProxyDrizzle(
  config?: Omit<DrizzleConfig<typeof schema>, "logger">,
): Effect.Effect<DrizzleDB, never, SqlClient> {
  return Effect.gen(function* () {
    const client = yield* SqlClient;

    const callback = (
      sql: string,
      params: unknown[],
      method: "all" | "run" | "get" | "values",
    ): Promise<{ rows: unknown[] | unknown[][] }> => {
      const statement = client.unsafe(sql, params);

      // "all"/"values" → statement.values (raw arrays, Drizzle applies its own mapping)
      // "get"/"run"    → statement.withoutTransform (raw objects)
      const base =
        method === "all" || method === "values" ? statement.values : statement.withoutTransform;

      // Wrap result in { rows } format expected by Drizzle proxy
      const effect =
        method === "get"
          ? Effect.map(base, (rows: ReadonlyArray<unknown>) => ({
              rows: (rows as ReadonlyArray<unknown>)[0] ?? [],
            }))
          : Effect.map(base, (rows) => ({ rows }));

      // Effect.runPromise rejects on error — matches Drizzle's Promise contract
      return Effect.runPromise(effect) as Promise<{ rows: unknown[] | unknown[][] }>;
    };

    return drizzleProxy(callback, { schema, ...config });
  });
}

// ---------------------------------------------------------------------------
// Query helper — wraps Drizzle queries in Effect
// ---------------------------------------------------------------------------

/**
 * Execute a Drizzle query within Effect.
 *
 *   const db = yield* SqliteDrizzle;
 *   const blocks = yield* query(db.select().from(schema.immutableBlocks));
 *   yield* query(db.insert(schema.tx).values({...}).onConflictDoNothing());
 */
export const query = <T>(drizzleQuery: Promise<T>): Effect.Effect<T> =>
  Effect.tryPromise({
    try: () => drizzleQuery,
    catch: (cause) => cause,
  });
