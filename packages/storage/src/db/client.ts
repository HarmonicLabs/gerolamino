/**
 * Drizzle ORM ↔ Effect v4 beta SqlClient bridge.
 *
 * Two driver strategies for maximum performance:
 *
 * 1. **BunSqlite** (TUI/server): Uses `drizzle-orm/bun-sqlite` directly.
 *    Zero proxy overhead — Drizzle talks to `bun:sqlite` synchronously.
 *    Wrapped in an Effect Layer for service composition.
 *
 * 2. **SqlClient proxy** (Chrome extension / cross-platform): Uses
 *    `drizzle-orm/sqlite-proxy` routing through Effect's abstract SqlClient.
 *    Follows @effect/sql-drizzle v3 patterns (`.values`/`.withoutTransform`,
 *    `currentRuntime` capture, `Effect.either` + throw).
 *
 * Both share the same schema and Drizzle query API. The entry point
 * provides the appropriate layer:
 *
 *   // TUI: direct bun:sqlite (fastest)
 *   const StorageLayer = SqliteDrizzle.layerBun({ filename: "chain.db" });
 *
 *   // Chrome: proxy through Effect SqlClient
 *   const StorageLayer = Layer.provide(SqliteDrizzle.layerProxy, WasmSqliteLayer);
 */
import { Effect, Layer, Runtime, ServiceMap } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { DrizzleConfig } from "drizzle-orm";
import { drizzle as drizzleProxy, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { drizzle as drizzleBun } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema.ts";

export { schema };

type DrizzleDB = SqliteRemoteDatabase<typeof schema>;

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
// (following @effect/sql-drizzle v3 internal/patch.ts patterns)
// ---------------------------------------------------------------------------

/**
 * Module-level runtime capture for fiber context optimization.
 * When a query executes inside an Effect fiber, we capture that fiber's
 * runtime so the proxy callback can reuse it (avoids creating new fibers).
 */
let currentRuntime: Runtime.Runtime<never> | undefined = undefined;

function makeProxyDrizzle(
  config?: Omit<DrizzleConfig<typeof schema>, "logger">,
): Effect.Effect<DrizzleDB, never, SqlClient> {
  return Effect.gen(function* () {
    const client = yield* SqlClient;
    const constructionRuntime = yield* Effect.runtime<never>();

    const callback = (
      sql: string,
      params: unknown[],
      method: "all" | "run" | "get" | "values",
    ): Promise<{ rows: unknown[] | unknown[][] }> => {
      const rt = currentRuntime ?? constructionRuntime;
      const run = Runtime.runPromise(rt);
      const statement = client.unsafe(sql, params);

      // Match @effect/sql-drizzle v3 behavior:
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

      // Use Effect.either to bridge typed errors to Promise rejections
      return run(Effect.either(effect)).then((res) => {
        if (res._tag === "Left") throw res.left;
        return res.right as { rows: unknown[] | unknown[][] };
      });
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
