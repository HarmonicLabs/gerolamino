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
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import * as IndexedDbTable from "@effect/platform-browser/IndexedDbTable";
import * as IndexedDbVersion from "@effect/platform-browser/IndexedDbVersion";
import * as IndexedDbDatabase from "@effect/platform-browser/IndexedDbDatabase";
import { layerMemory as sqliteWasmMemoryLayer } from "@effect/sql-sqlite-wasm/SqliteClient";
import { BlobStore, BlobStoreError, prefixEnd, ChainDBLive, SqliteDrizzle } from "storage";

// ---------------------------------------------------------------------------
// Hex encoding — keys stored as hex strings for IDB range queries
// ---------------------------------------------------------------------------

const toHex = (buf: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i]!.toString(16).padStart(2, "0");
  return s;
};

const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

// ---------------------------------------------------------------------------
// IndexedDB table definitions — one per LSM key prefix
// ---------------------------------------------------------------------------

/** Shared schema for all blob object stores. */
const blobSchema = Schema.Struct({
  hexKey: Schema.String,
  value: Schema.Uint8Array,
});

// V1: original single "blobs" object store (kept for migration chain)
const BlobsTable = IndexedDbTable.make({ name: "blobs", schema: blobSchema, keyPath: "hexKey" });
const BlobDbV1 = IndexedDbVersion.make(BlobsTable);

// V2: separate object stores per LSM key prefix
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
const BlobDbV2 = IndexedDbVersion.make(
  UtxoTable,
  BlocksTable,
  BlockIndexTable,
  StakeTable,
  AccountsTable,
  OffsetsTable,
);

const BlobDbSchema = IndexedDbDatabase.make(BlobDbV1, (query) =>
  Effect.gen(function* () {
    yield* query.createObjectStore("blobs");
  }),
).add(
  BlobDbV2,
  Effect.fnUntraced(function* (fromQuery, toQuery) {
    yield* fromQuery.deleteObjectStore("blobs");
    yield* toQuery.createObjectStore("utxo");
    yield* toQuery.createObjectStore("blocks");
    yield* toQuery.createObjectStore("block_index");
    yield* toQuery.createObjectStore("stake");
    yield* toQuery.createObjectStore("accounts");
    yield* toQuery.createObjectStore("offsets");
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

const fail = (operation: string, cause: unknown) => new BlobStoreError({ operation, cause });

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
    const qb = yield* BlobDbSchema;

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
          const entries = yield* tableFor(key).select().equals(toHex(key));
          return Option.fromNullishOr(entries[0]?.value);
        }).pipe(Effect.mapError((cause) => fail("get", cause))),

      put: (key: Uint8Array, value: Uint8Array) =>
        Effect.gen(function* () {
          yield* tableFor(key).upsert({ hexKey: toHex(key), value });
        }).pipe(Effect.mapError((cause) => fail("put", cause))),

      delete: (key: Uint8Array) =>
        Effect.gen(function* () {
          yield* tableFor(key).delete().equals(toHex(key));
        }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => fail("delete", cause)),
        ),

      has: (key: Uint8Array) =>
        Effect.gen(function* () {
          const count: number = yield* tableFor(key).count().equals(toHex(key));
          return count > 0;
        }).pipe(Effect.mapError((cause) => fail("has", cause))),

      scan: (prefix: Uint8Array) => {
        const table = tableFor(prefix);
        const lo = toHex(prefix);
        const hi = toHex(prefixEnd(prefix));
        return Stream.fromEffect(
          Effect.gen(function* () {
            return hi === ""
              ? yield* table.select().gte(lo)
              : yield* table.select().between(lo, hi, { excludeUpperBound: true });
          }),
        ).pipe(
          Stream.flatMap((entries) => Stream.fromIterable(entries)),
          Stream.map((entry) => ({
            key: fromHex(entry.hexKey),
            value: entry.value,
          })),
          Stream.mapError((cause) => fail("scan", cause)),
        );
      },

      putBatch: (
        entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>,
      ) =>
        Effect.gen(function* () {
          // Group entries by target table, then bulk-upsert per table.
          // During bootstrap, batches are typically single-prefix (all UTxO or all blocks).
          const groups = new Map<TableName, Array<{ hexKey: string; value: Uint8Array }>>();
          for (const e of entries) {
            const name = resolveTableName(e.key);
            let group = groups.get(name);
            if (!group) {
              group = [];
              groups.set(name, group);
            }
            group.push({ hexKey: toHex(e.key), value: e.value });
          }
          for (const [name, group] of groups) {
            yield* tables[name].upsertAll(group);
          }
        }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => fail("putBatch", cause)),
        ),

      deleteBatch: (keys: ReadonlyArray<Uint8Array>) =>
        Effect.forEach(keys, (key) =>
          Effect.gen(function* () {
            yield* tableFor(key).delete().equals(toHex(key));
          }),
        ).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => fail("deleteBatch", cause)),
        ),
    };
  }),
).pipe(Layer.provide(BlobDbSchema.layer("gerolamino-blobs")));

// ---------------------------------------------------------------------------
// SQLite WASM (in-memory) SqlClient — for ChainDB relational storage
// ---------------------------------------------------------------------------

/**
 * In-memory SQLite WASM — provides both SqlClient (for migrations) and SqliteDrizzle.
 *
 * MV3 service workers cannot create Web Workers, so we use in-memory mode.
 * Metadata is ephemeral — blocks and UTxO persist in IndexedDB via BlobStore.
 * Callers must run migrations before use (in-memory DB starts empty).
 */
const SqliteWasmLayer = SqliteDrizzle.layerProxy.pipe(
  Layer.provideMerge(sqliteWasmMemoryLayer({}).pipe(Layer.orDie)),
);

// ---------------------------------------------------------------------------
// Composite storage layer
// ---------------------------------------------------------------------------

/**
 * Full browser storage: IndexedDB BlobStore + in-memory SQLite WASM ChainDB.
 *
 * Requires IndexedDb service in the environment.
 */
export const BrowserStorageLayers = () =>
  ChainDBLive.pipe(Layer.provideMerge(Layer.merge(BlobStoreIndexedDB, SqliteWasmLayer)));
