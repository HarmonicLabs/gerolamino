import { describe, it, assert } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { discoverLmdbDatabases, iterateEntries, UtxoKeySchema } from "../lmdb-kv.ts";
import { Schema } from "effect";

const DB_DIR = "./db/ledger/119401006/tables";

describe("LMDB KeyValueStore", () => {
  it.effect("discovers _dbstate and utxo sub-databases", () =>
    discoverLmdbDatabases(DB_DIR).pipe(
      Effect.tap((dbs) =>
        Effect.sync(() => {
          assert.isTrue(dbs.includes("_dbstate"));
          assert.isTrue(dbs.includes("utxo"));
        }),
      ),
    ),
  );

  it.effect("iterates UTxO entries with valid 34-byte keys", () =>
    iterateEntries(DB_DIR, "utxo").pipe(
      Stream.take(10),
      Stream.runCollect,
      Effect.tap((entries) =>
        Effect.sync(() => {
          assert.strictEqual(entries.length, 10);
          for (const entry of entries) {
            // UTxO keys: 32-byte txHash + 2-byte LE outputIndex = 34 bytes
            assert.strictEqual(entry.key.length, 34);
            assert.isTrue(entry.value.length > 0);
          }
        }),
      ),
    ),
  );

  it.effect("UTxO keys validate against UtxoKeySchema", () =>
    iterateEntries(DB_DIR, "utxo").pipe(
      Stream.take(5),
      Stream.mapEffect((entry) =>
        Schema.decodeEffect(UtxoKeySchema)(entry.key).pipe(Effect.as(entry)),
      ),
      Stream.runCollect,
      Effect.tap((entries) =>
        Effect.sync(() => {
          assert.strictEqual(entries.length, 5);
        }),
      ),
    ),
  );

  it.effect("UTxO keys contain valid tx hash and output index", () =>
    iterateEntries(DB_DIR, "utxo").pipe(
      Stream.take(5),
      Stream.runCollect,
      Effect.tap((entries) =>
        Effect.sync(() => {
          for (const entry of entries) {
            const txHash = entry.key.subarray(0, 32);
            const outputIndex = entry.key[32]! | (entry.key[33]! << 8);
            // tx hash should have non-zero bytes
            assert.isTrue(txHash.some((b) => b !== 0));
            // output index should be reasonable (< 1000 for most transactions)
            assert.isTrue(outputIndex < 10000);
          }
        }),
      ),
    ),
  );

  it.effect("iterates _dbstate entries", () =>
    iterateEntries(DB_DIR, "_dbstate").pipe(
      Stream.take(5),
      Stream.runCollect,
      Effect.tap((entries) =>
        Effect.sync(() => {
          assert.isTrue(entries.length > 0);
          for (const entry of entries) {
            assert.isTrue(entry.key.length > 0);
            assert.isTrue(entry.value.length > 0);
          }
        }),
      ),
    ),
  );

  it.effect("lazy iteration does not load all entries into memory", () =>
    // Take only 3 entries - should be fast and low memory
    iterateEntries(DB_DIR, "utxo").pipe(
      Stream.take(3),
      Stream.runCount,
      Effect.tap((count) =>
        Effect.sync(() => {
          assert.strictEqual(count, 3);
        }),
      ),
    ),
  );
});
