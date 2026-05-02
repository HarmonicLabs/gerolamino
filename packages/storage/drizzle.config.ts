/**
 * Drizzle Kit config — generates migration SQL files from the schema in
 * `src/schema/`. Driver-agnostic (`dialect: "sqlite"`); we never feed it
 * a credentials block because we don't run migrations through Drizzle's
 * runner — the `effect/unstable/sql/Migrator` keeps owning the journal.
 *
 * Output: `src/migrations/<NNNN>_<name>.sql`. Those files are committed
 * and replayed at boot by the rewritten `operations/migrations.ts`.
 *
 * Run via `bun run drizzle:generate` (script in `package.json`).
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
});
