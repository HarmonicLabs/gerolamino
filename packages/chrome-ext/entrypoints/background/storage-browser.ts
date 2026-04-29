/**
 * Browser storage layers — IndexedDB BlobStore + SQLite WASM (OPFS) ChainDB.
 *
 * BlobStore: Effect v4 IndexedDbTable + IndexedDbQueryBuilder for typed,
 *   schema-driven key-value storage in IndexedDB. Uses separate object stores
 *   per key prefix, matching the LSM tree table structure:
 *     utxo        — UTxO entries (PREFIX_UTXO)
 *     blocks      — Block CBOR (PREFIX_BLK)
 *     block_index — Block number index (PREFIX_BIDX)
 *     stake       — Stake distribution (PREFIX_STAK)
 *     accounts    — Account metadata (PREFIX_ACCT)
 *     offsets     — CBOR offset index (PREFIX_COFF)
 *
 * SqlClient: @effect/sql-sqlite-wasm with in-memory mode.
 * ChainDB: standard ChainDBLive from storage package, consuming both.
 */
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { groupBy } from "es-toolkit";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import * as IndexedDbTable from "@effect/platform-browser/IndexedDbTable";
import * as IndexedDbVersion from "@effect/platform-browser/IndexedDbVersion";
import * as IndexedDbDatabase from "@effect/platform-browser/IndexedDbDatabase";
import { layerMemory as sqliteWasmMemoryLayer } from "@effect/sql-sqlite-wasm/SqliteClient";
import {
  type BlobEntry,
  BlobStore,
  BlobStoreError,
  type BlobStoreOperation,
  prefixEnd,
  ChainDBLive,
  LedgerSnapshotStoreLive,
} from "storage";

// ---------------------------------------------------------------------------
// IndexedDB table definitions — one per LSM key prefix
// ---------------------------------------------------------------------------

/** Shared schema for all blob object stores. */
const blobSchema = Schema.Struct({
  hexKey: Schema.String,
  value: Schema.Uint8Array,
});

// Single, current schema: one object store per LSM key prefix. No migrations —
// the DB name `gerolamino-chain-store` is fresh so legacy gerolamino-blobs DBs
// from earlier builds are ignored (Chrome keeps them around but unused).
const UtxoTable = IndexedDbTable.make({ name: "utxo", schema: blobSchema, keyPath: "hexKey" });
const BlocksTable = IndexedDbTable.make({ name: "blocks", schema: blobSchema, keyPath: "hexKey" });
const BlockIndexTable = IndexedDbTable.make({
  name: "block_index",
  schema: blobSchema,
  keyPath: "hexKey",
});
const StakeTable = IndexedDbTable.make({ name: "stake", schema: blobSchema, keyPath: "hexKey" });
const AccountsTable = IndexedDbTable.make({
  name: "accounts",
  schema: blobSchema,
  keyPath: "hexKey",
});
const OffsetsTable = IndexedDbTable.make({
  name: "offsets",
  schema: blobSchema,
  keyPath: "hexKey",
});
const BlobDbVersion = IndexedDbVersion.make(
  UtxoTable,
  BlocksTable,
  BlockIndexTable,
  StakeTable,
  AccountsTable,
  OffsetsTable,
);

const BlobDbSchema = IndexedDbDatabase.make(BlobDbVersion, (query) =>
  Effect.gen(function* () {
    yield* Effect.log(
      "[storage] Creating IndexedDB object stores (utxo, blocks, block_index, stake, accounts, offsets)",
    );
    yield* query.createObjectStore("utxo");
    yield* query.createObjectStore("blocks");
    yield* query.createObjectStore("block_index");
    yield* query.createObjectStore("stake");
    yield* query.createObjectStore("accounts");
    yield* query.createObjectStore("offsets");
    yield* Effect.log("[storage] Object stores created");
  }),
);

// ---------------------------------------------------------------------------
// Prefix → table routing
// ---------------------------------------------------------------------------

type TableName = "utxo" | "blocks" | "block_index" | "stake" | "accounts" | "offsets";

/** Route a binary key to the correct object store based on its 4-byte prefix. */
const resolveTableName = (key: Uint8Array): TableName => {
  if (key.length < 4) return "utxo";
  const p0 = key[0]!,
    p1 = key[1]!,
    p2 = key[2]!,
    p3 = key[3]!;
  // "utxo" = 75 74 78 6f
  if (p0 === 0x75 && p1 === 0x74 && p2 === 0x78 && p3 === 0x6f) return "utxo";
  // "blk:" = 62 6c 6b 3a
  if (p0 === 0x62 && p1 === 0x6c && p2 === 0x6b && p3 === 0x3a) return "blocks";
  // "bidx" = 62 69 64 78
  if (p0 === 0x62 && p1 === 0x69 && p2 === 0x64 && p3 === 0x78) return "block_index";
  // "stak" = 73 74 61 6b
  if (p0 === 0x73 && p1 === 0x74 && p2 === 0x61 && p3 === 0x6b) return "stake";
  // "acct" = 61 63 63 74
  if (p0 === 0x61 && p1 === 0x63 && p2 === 0x63 && p3 === 0x74) return "accounts";
  // "coff" = 63 6f 66 66
  if (p0 === 0x63 && p1 === 0x6f && p2 === 0x66 && p3 === 0x66) return "offsets";
  return "utxo";
};

// ---------------------------------------------------------------------------
// IndexedDB BlobStore — separate object stores per prefix
// ---------------------------------------------------------------------------

const fail = (operation: BlobStoreOperation, cause: unknown) =>
  new BlobStoreError({ operation, cause });

/**
 * IndexedDB-backed BlobStore with per-prefix object stores.
 *
 * Keys include the 4-byte prefix (same format as LSM tree). The prefix
 * determines which object store the entry is routed to. This matches the
 * reference node's multi-table LSM structure while keeping the BlobStore
 * interface unchanged.
 */
export const BlobStoreIndexedDB: Layer.Layer<
  BlobStore,
  IndexedDbDatabase.IndexedDbDatabaseError,
  IndexedDb.IndexedDb
> = Layer.effect(
  BlobStore,
  Effect.gen(function* () {
    yield* Effect.log("[storage] Opening IndexedDB 'gerolamino-chain-store'...");
    const qb = yield* BlobDbSchema;
    yield* Effect.log("[storage] IndexedDB BlobStore ready");

    // Pre-resolve query builders for each table
    const tables = {
      utxo: qb.from("utxo"),
      blocks: qb.from("blocks"),
      block_index: qb.from("block_index"),
      stake: qb.from("stake"),
      accounts: qb.from("accounts"),
      offsets: qb.from("offsets"),
    };

    const tableFor = (key: Uint8Array) => tables[resolveTableName(key)];

    return {
      get: (key: Uint8Array) =>
        Effect.gen(function* () {
          const entries = yield* tableFor(key).select().equals(key.toHex());
          return Option.fromNullishOr(entries[0]?.value);
        }).pipe(Effect.mapError((cause) => fail("get", cause))),

      put: (key: Uint8Array, value: Uint8Array) =>
        Effect.gen(function* () {
          yield* tableFor(key).upsert({ hexKey: key.toHex(), value });
        }).pipe(Effect.mapError((cause) => fail("put", cause))),

      delete: (key: Uint8Array) =>
        Effect.gen(function* () {
          yield* tableFor(key).delete().equals(key.toHex());
        }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => fail("delete", cause)),
        ),

      has: (key: Uint8Array) =>
        Effect.gen(function* () {
          const count: number = yield* tableFor(key).count().equals(key.toHex());
          return count > 0;
        }).pipe(Effect.mapError((cause) => fail("has", cause))),

      scan: (prefix: Uint8Array) => {
        const table = tableFor(prefix);
        const lo = prefix.toHex();
        const hi = prefixEnd(prefix).toHex();
        return Stream.fromEffect(
          Effect.gen(function* () {
            return hi === ""
              ? yield* table.select().gte(lo)
              : yield* table.select().between(lo, hi, { excludeUpperBound: true });
          }),
        ).pipe(
          Stream.flatMap((entries) => Stream.fromIterable(entries)),
          Stream.map((entry) => ({
            key: Uint8Array.fromHex(entry.hexKey),
            value: entry.value,
          })),
          Stream.mapError((cause) => fail("scan", cause)),
        );
      },

      putBatch: (entries: ReadonlyArray<BlobEntry>) =>
        Effect.gen(function* () {
          // Group entries by target table, then bulk-upsert per table.
          // During bootstrap, batches are typically single-prefix (all UTxO
          // or all blocks). `groupBy` is declarative and returns a plain
          // Record, which iterates cleanly via `Object.entries`.
          const grouped = groupBy(entries, (e) => resolveTableName(e.key));
          for (const [name, bucket] of Object.entries(grouped)) {
            yield* tables[name as TableName].upsertAll(
              bucket.map((e) => ({ hexKey: e.key.toHex(), value: e.value })),
            );
          }
        }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => fail("putBatch", cause)),
        ),

      deleteBatch: (keys: ReadonlyArray<Uint8Array>) =>
        Effect.forEach(keys, (key) =>
          Effect.gen(function* () {
            yield* tableFor(key).delete().equals(key.toHex());
          }),
        ).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => fail("deleteBatch", cause)),
        ),
    };
  }),
).pipe(Layer.provide(BlobDbSchema.layer("gerolamino-chain-store")));

// ---------------------------------------------------------------------------
// SQLite WASM (in-memory) SqlClient — for ChainDB relational storage
// ---------------------------------------------------------------------------

/**
 * In-memory SQLite WASM — provides SqlClient for migrations and ChainDB.
 *
 * MV3 service workers cannot create Web Workers, so we use in-memory mode.
 * Metadata is ephemeral — blocks and UTxO persist in IndexedDB via BlobStore.
 * Callers must run migrations before use (in-memory DB starts empty).
 */
const SqliteWasmLayer = sqliteWasmMemoryLayer({}).pipe(Layer.orDie);

// ---------------------------------------------------------------------------
// Composite storage layer
// ---------------------------------------------------------------------------

/**
 * Full browser storage: IndexedDB BlobStore + in-memory SQLite WASM
 * ChainDB + LedgerSnapshotStore (the latter required by the consensus
 * `connectToRelay` driver — without it the SW dies on first sync attempt
 * with `Service not found: storage/LedgerSnapshotStore`).
 *
 * Both stores share the same `BlobStore` + `SqlClient` deps via
 * `Layer.provideMerge`, mirroring the `apps/tui` composition.
 *
 * Requires IndexedDb service in the environment.
 */
export const BrowserStorageLayers = () => {
  const deps = Layer.merge(BlobStoreIndexedDB, SqliteWasmLayer);
  return Layer.mergeAll(
    ChainDBLive.pipe(Layer.provide(deps)),
    LedgerSnapshotStoreLive.pipe(Layer.provide(deps)),
    deps,
  );
};
