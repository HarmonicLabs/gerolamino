/**
 * SQL integration tests — real SQLite via @effect/sql-sqlite-bun.
 *
 * Proves that migrations, block operations, snapshot operations, and BlobStore
 * integration work against a real in-memory SQLite database (not stubs).
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { layer as layerBunSqlClient } from "@effect/sql-sqlite-bun/SqliteClient";
import { type BlobEntry, BlobStore } from "../blob-store/service.ts";
import { blockKey, snapshotKey } from "../blob-store/keys.ts";
import { runMigrations } from "../operations/migrations.ts";
import {
  writeImmutableBlock,
  readImmutableBlock,
  getImmutableTip,
  writeVolatileBlock,
  readVolatileBlock,
  getVolatileSuccessors,
  garbageCollectVolatile,
} from "../operations/blocks.ts";
import { writeSnapshot, readLatestSnapshot } from "../operations/snapshots.ts";
import type { StoredBlock, RealPoint } from "../types/StoredBlock.ts";

// ---------------------------------------------------------------------------
// Test layer: in-memory SQLite + in-memory BlobStore stub
// ---------------------------------------------------------------------------

const sqlLayer = layerBunSqlClient({ filename: ":memory:" });

/** In-memory BlobStore backed by a Map — isolates SQL testing from blob storage. */
const makeInMemoryBlobStore = () => {
  const store = new Map<string, Uint8Array>();
  const keyStr = (k: Uint8Array) => k.toHex();

  return {
    get: (key: Uint8Array) => Effect.succeed(Option.fromNullishOr(store.get(keyStr(key)))),
    put: (key: Uint8Array, value: Uint8Array) =>
      Effect.sync(() => {
        store.set(keyStr(key), value);
      }),
    delete: (key: Uint8Array) =>
      Effect.sync(() => {
        store.delete(keyStr(key));
      }),
    has: (key: Uint8Array) => Effect.succeed(store.has(keyStr(key))),
    scan: () => {
      throw new Error("scan not needed in sql-integration tests");
    },
    putBatch: (entries: ReadonlyArray<BlobEntry>) =>
      Effect.sync(() => {
        for (const e of entries) store.set(keyStr(e.key), e.value);
      }),
    deleteBatch: (keys: ReadonlyArray<Uint8Array>) =>
      Effect.sync(() => {
        for (const k of keys) store.delete(keyStr(k));
      }),
  };
};

const blobLayer = Layer.succeed(BlobStore, makeInMemoryBlobStore());
const testLayer = Layer.merge(sqlLayer, blobLayer);

/** Provide an effect that needs SqlClient + BlobStore, with fresh migrations. */
const provide = <A>(effect: Effect.Effect<A, unknown, SqlClient | BlobStore>) =>
  runMigrations.pipe(Effect.andThen(effect), Effect.provide(testLayer));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeBlock = (slot: bigint, blockNo: bigint, prevHash?: Uint8Array): StoredBlock => ({
  slot,
  blockNo,
  hash: new Uint8Array(32).fill(Number(slot & 0xffn)),
  prevHash,
  blockSizeBytes: 256,
  blockCbor: new Uint8Array(256).fill(Number(slot & 0xffn)),
});

const pointOf = (block: StoredBlock): RealPoint => ({
  slot: block.slot,
  hash: block.hash,
});

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe("migrations", () => {
  it.effect("creates all expected tables", () =>
    provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
        `;
        const names = (tables as ReadonlyArray<{ name: string }>).map((r) => r.name);
        expect(names).toContain("immutable_blocks");
        expect(names).toContain("volatile_blocks");
        expect(names).toContain("ledger_snapshots");
        expect(names).toContain("tx");
        expect(names).toContain("tx_out");
      }),
    ),
  );

  it.effect("is idempotent", () =>
    Effect.gen(function* () {
      yield* runMigrations;
      yield* runMigrations;
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("sets WAL mode (falls back to 'memory' for in-memory DBs)", () =>
    provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql`PRAGMA journal_mode`.unprepared;
        const mode = (rows as ReadonlyArray<{ journal_mode: string }>)[0]!.journal_mode;
        // In-memory SQLite cannot use WAL — returns "memory" instead.
        // On-disk databases (TUI, production) will use WAL.
        expect(["wal", "memory"]).toContain(mode);
      }),
    ),
  );

  it.effect("enables foreign keys", () =>
    provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql`PRAGMA foreign_keys`.unprepared;
        const fk = (rows as ReadonlyArray<{ foreign_keys: number }>)[0]!.foreign_keys;
        expect(fk).toBe(1);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Immutable blocks
// ---------------------------------------------------------------------------

describe("immutable blocks", () => {
  it.effect("write + read round-trip", () =>
    provide(
      Effect.gen(function* () {
        const block = makeBlock(100n, 50n);
        yield* writeImmutableBlock(block);
        const result = yield* readImmutableBlock(pointOf(block));

        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) {
          expect(result.value.slot).toBe(100n);
          expect(result.value.blockNo).toBe(50n);
          expect(result.value.hash).toEqual(block.hash);
          expect(result.value.blockCbor).toEqual(block.blockCbor);
        }
      }),
    ),
  );

  it.effect("ON CONFLICT updates hash", () =>
    provide(
      Effect.gen(function* () {
        const block1 = makeBlock(100n, 50n);
        yield* writeImmutableBlock(block1);

        // Same slot, different hash
        const block2 = { ...makeBlock(100n, 50n), hash: new Uint8Array(32).fill(0xab) };
        yield* writeImmutableBlock(block2);

        const result = yield* readImmutableBlock({ slot: 100n, hash: block2.hash });
        expect(Option.isSome(result)).toBe(true);
      }),
    ),
  );

  it.effect("getTip returns highest slot", () =>
    provide(
      Effect.gen(function* () {
        yield* writeImmutableBlock(makeBlock(100n, 50n));
        yield* writeImmutableBlock(makeBlock(300n, 150n));
        yield* writeImmutableBlock(makeBlock(200n, 100n));

        const tip = yield* getImmutableTip;
        expect(Option.isSome(tip)).toBe(true);
        if (Option.isSome(tip)) {
          expect(tip.value.slot).toBe(300n);
        }
      }),
    ),
  );

  it.effect("getTip returns None on empty DB", () =>
    provide(
      Effect.gen(function* () {
        const tip = yield* getImmutableTip;
        expect(Option.isNone(tip)).toBe(true);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Volatile blocks
// ---------------------------------------------------------------------------

describe("volatile blocks", () => {
  it.effect("write + read round-trip", () =>
    provide(
      Effect.gen(function* () {
        const block = makeBlock(100n, 50n);
        yield* writeVolatileBlock(block);
        const result = yield* readVolatileBlock(block.hash);

        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) {
          expect(result.value.slot).toBe(100n);
          expect(result.value.blockNo).toBe(50n);
          expect(result.value.blockCbor).toEqual(block.blockCbor);
        }
      }),
    ),
  );

  it.effect("ON CONFLICT DO NOTHING", () =>
    provide(
      Effect.gen(function* () {
        const block = makeBlock(100n, 50n);
        yield* writeVolatileBlock(block);
        yield* writeVolatileBlock(block); // should not throw
        const result = yield* readVolatileBlock(block.hash);
        expect(Option.isSome(result)).toBe(true);
      }),
    ),
  );

  it.effect("getSuccessors finds child blocks", () =>
    provide(
      Effect.gen(function* () {
        const parent = makeBlock(100n, 50n);
        const child1: StoredBlock = {
          ...makeBlock(101n, 51n),
          hash: new Uint8Array(32).fill(0x01),
          prevHash: parent.hash,
        };
        const child2: StoredBlock = {
          ...makeBlock(102n, 52n),
          hash: new Uint8Array(32).fill(0x02),
          prevHash: parent.hash,
        };

        yield* writeVolatileBlock(parent);
        yield* writeVolatileBlock(child1);
        yield* writeVolatileBlock(child2);

        const succs = yield* getVolatileSuccessors(parent.hash);
        expect(succs.length).toBe(2);
      }),
    ),
  );

  it.effect("garbageCollect removes old blocks", () =>
    provide(
      Effect.gen(function* () {
        yield* writeVolatileBlock(makeBlock(100n, 50n));
        yield* writeVolatileBlock(makeBlock(200n, 100n));
        yield* writeVolatileBlock(makeBlock(300n, 150n));

        yield* garbageCollectVolatile(250);

        // Blocks at 100 and 200 should be gone
        const r100 = yield* readVolatileBlock(makeBlock(100n, 50n).hash);
        const r200 = yield* readVolatileBlock(makeBlock(200n, 100n).hash);
        const r300 = yield* readVolatileBlock(makeBlock(300n, 150n).hash);
        expect(Option.isNone(r100)).toBe(true);
        expect(Option.isNone(r200)).toBe(true);
        expect(Option.isSome(r300)).toBe(true);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe("ledger snapshots", () => {
  it.effect("write + read round-trip", () =>
    provide(
      Effect.gen(function* () {
        const snapshot = {
          point: { slot: 100n, hash: new Uint8Array(32).fill(0xaa) },
          stateBytes: new Uint8Array([1, 2, 3, 4, 5]),
          epoch: 5n,
          slot: 100n,
        };
        yield* writeSnapshot(snapshot);
        const result = yield* readLatestSnapshot;

        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) {
          expect(result.value.slot).toBe(100n);
          expect(result.value.epoch).toBe(5n);
          expect(result.value.stateBytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
        }
      }),
    ),
  );

  it.effect("returns latest by slot", () =>
    provide(
      Effect.gen(function* () {
        yield* writeSnapshot({
          point: { slot: 100n, hash: new Uint8Array(32).fill(0x01) },
          stateBytes: new Uint8Array([1]),
          epoch: 5n,
          slot: 100n,
        });
        yield* writeSnapshot({
          point: { slot: 200n, hash: new Uint8Array(32).fill(0x02) },
          stateBytes: new Uint8Array([2]),
          epoch: 6n,
          slot: 200n,
        });

        const result = yield* readLatestSnapshot;
        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) {
          expect(result.value.slot).toBe(200n);
          expect(result.value.epoch).toBe(6n);
        }
      }),
    ),
  );

  it.effect("returns None on empty DB", () =>
    provide(
      Effect.gen(function* () {
        const result = yield* readLatestSnapshot;
        expect(Option.isNone(result)).toBe(true);
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// BlobStore integration — verifies dual-layer split
// ---------------------------------------------------------------------------

describe("BlobStore integration", () => {
  it.effect("block CBOR in BlobStore, metadata in SQL", () =>
    provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const store = yield* BlobStore;

        const block = makeBlock(100n, 50n);
        yield* writeImmutableBlock(block);

        // BlobStore should have the CBOR blob
        const blob = yield* store.get(blockKey(block.slot, block.hash));
        expect(Option.isSome(blob)).toBe(true);
        if (Option.isSome(blob)) {
          expect(blob.value).toEqual(block.blockCbor);
        }

        // SQL should have the metadata
        const rows = yield* sql`
          SELECT slot, hash, block_no FROM immutable_blocks WHERE slot = 100
        `;
        expect((rows as ReadonlyArray<unknown>).length).toBe(1);
      }),
    ),
  );

  it.effect("snapshot stateBytes in BlobStore", () =>
    provide(
      Effect.gen(function* () {
        const store = yield* BlobStore;

        const snapshot = {
          point: { slot: 100n, hash: new Uint8Array(32).fill(0xaa) },
          stateBytes: new Uint8Array([10, 20, 30]),
          epoch: 5n,
          slot: 100n,
        };
        yield* writeSnapshot(snapshot);

        const blob = yield* store.get(snapshotKey(100n));
        expect(Option.isSome(blob)).toBe(true);
        if (Option.isSome(blob)) {
          expect(blob.value).toEqual(new Uint8Array([10, 20, 30]));
        }
      }),
    ),
  );
});
