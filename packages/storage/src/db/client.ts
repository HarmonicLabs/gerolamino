/**
 * Drizzle ORM ↔ Effect v4 beta SqlClient bridge.
 *
 * Routes `drizzle-orm/sqlite-proxy` through Effect's abstract SqlClient.
 * Platform-specific SqlClient layers (bun:sqlite, WASM, etc.) are provided
 * at the entrypoint — this module is platform-agnostic.
 *
 * Recommended composition:
 *
 *   const sqlClient  = layerBunSqlClient({ filename: "chain.db" });  // in app
 *   const drizzle    = SqliteDrizzle.layerProxy.pipe(Layer.provide(sqlClient));
 *   // runMigrations consumes SqlClient; ChainDBLive consumes SqliteDrizzle + BlobStore
 */
import { Effect, Layer, ServiceMap } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { DrizzleConfig } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core/db";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema.ts";

export { schema };

/** Drizzle DB interface — async proxy backend through abstract SqlClient. */
type DrizzleDB = BaseSQLiteDatabase<"async", unknown, typeof schema>;

// ---------------------------------------------------------------------------
// SqliteDrizzle service
// ---------------------------------------------------------------------------

/**
 * SqliteDrizzle service — yield* this in Effect.gen to get a type-safe
 * Drizzle query builder. Routes all SQL through the abstract SqlClient.
 */
export class SqliteDrizzle extends ServiceMap.Service<SqliteDrizzle, DrizzleDB>()(
  "@storage/SqliteDrizzle",
) {
  /**
   * Proxy layer through Effect SqlClient — for cross-platform use.
   * Requires SqlClient in environment (bun:sqlite, WasmSqlite, etc.).
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
      if (method === "get") {
        return Effect.runPromise(
          Effect.map(base, (rows: ReadonlyArray<unknown>): { rows: unknown[] | unknown[][] } => ({
            rows: Array.isArray(rows[0]) ? [rows[0]] : [],
          })),
        );
      }
      // Effect.runPromise rejects on error — matches Drizzle's Promise contract
      return Effect.runPromise(
        Effect.map(base, (rows: ReadonlyArray<unknown>): { rows: unknown[] | unknown[][] } => ({
          rows: [...rows],
        })),
      );
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
  }).pipe(Effect.orDie);
