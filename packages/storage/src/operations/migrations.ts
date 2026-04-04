/**
 * SQL migrations — schema creation for the storage layer.
 *
 * Uses abstract SqlClient — works with SQLite WASM (browser),
 * SQLite Bun (server), or any other SqlClient implementation.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

export const runMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient;

  // Immutable blocks table
  yield* sql`
    CREATE TABLE IF NOT EXISTS immutable_blocks (
      slot INTEGER PRIMARY KEY,
      hash BLOB NOT NULL,
      prev_hash BLOB,
      block_no INTEGER NOT NULL,
      block_size_bytes INTEGER NOT NULL,
      block_cbor BLOB NOT NULL
    )
  `.unprepared;

  // Volatile blocks table (keyed by hash)
  yield* sql`
    CREATE TABLE IF NOT EXISTS volatile_blocks (
      hash BLOB PRIMARY KEY,
      slot INTEGER NOT NULL,
      prev_hash BLOB,
      block_no INTEGER NOT NULL,
      block_size_bytes INTEGER NOT NULL,
      block_cbor BLOB NOT NULL
    )
  `.unprepared;

  // Index on prev_hash for successor lookups
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_volatile_prev_hash ON volatile_blocks(prev_hash)
  `.unprepared;

  // Ledger state snapshots
  yield* sql`
    CREATE TABLE IF NOT EXISTS ledger_snapshots (
      slot INTEGER PRIMARY KEY,
      hash BLOB NOT NULL,
      epoch INTEGER NOT NULL,
      state_bytes BLOB NOT NULL
    )
  `.unprepared;

  yield* Effect.log("Storage migrations complete");
});
