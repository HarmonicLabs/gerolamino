/**
 * TUI-side SQLite layer composition.
 *
 * Composes `@effect/sql-sqlite-bun`'s `SqliteClient.layer({ filename })`
 * (the runtime + connection-pool layer) with `MigrationsLive` from
 * `storage/db` (which applies `migration_001`'s DDL on first connect
 * + bumps `schema_version`). The result is a Layer that, when
 * launched, opens `<dataDir>/chain.db`, runs migrations, and exposes
 * the `SqlClient` service for consumers.
 *
 * Drizzle queries layer on top: callers can `import { db } from "..."`
 * and use Drizzle's typed query builder, but the connection
 * lifetime + migration choreography are managed here.
 *
 * Why a separate db.ts and not inline in index.ts: cleaner Layer
 * composition + test layer can swap `SqliteClient.layer({ filename:
 * ":memory:" })` for in-memory SQL without touching index.ts.
 */
import { Layer } from "effect";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { MigrationsLive } from "storage/db";

/**
 * Build a `SqlClient` Layer rooted at the TUI's data directory.
 * Pass `:memory:` for tests; pass a directory path for production
 * (the layer appends `/chain.db` to the path).
 *
 * Migration application is idempotent — re-launching the same Layer
 * on a populated database is a no-op past the first call.
 */
export const DatabaseLive = (dataDir: string) =>
  SqliteClient.layer({
    filename: dataDir === ":memory:" ? ":memory:" : `${dataDir}/chain.db`,
  }).pipe(Layer.provideMerge(MigrationsLive));
