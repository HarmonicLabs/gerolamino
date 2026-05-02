/**
 * Drizzle schema barrel — single source of truth for the chain DB.
 *
 * Storage uses these definitions in two ways:
 *   1. As types — `typeof immutableBlocks.$inferSelect` replaces the
 *      hand-written `Schema.Struct` row schemas in `operations/blocks.ts`.
 *   2. As query builders — Drizzle's lexical `.toSQL()` plus
 *      `client.unsafe(...)` (see `services/drizzle.ts`) execute reads
 *      and writes; the underlying transport stays the abstract
 *      `SqlClient` from `effect/unstable/sql/SqlClient`.
 *
 * Imports stay on `drizzle-orm/sqlite-core` (the dialect-abstract
 * builder + column types). The dialect-specific drivers
 * (`drizzle-orm/bun-sqlite`, `drizzle-orm/sqlite-wasm`) are forbidden in
 * this package per the abstraction-boundary rule — platform-specific
 * `SqlClient` layers live in `apps/tui` and `packages/chrome-ext`.
 */
export * from "./chain.ts";
export * from "./tx.ts";
export * from "./pool.ts";
export * from "./epoch.ts";
export * from "./gov.ts";
