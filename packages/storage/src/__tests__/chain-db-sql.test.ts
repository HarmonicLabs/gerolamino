/**
 * ChainDBLive integration tests — real SQLite + in-memory BlobStore.
 *
 * Proves the full ChainDB service works end-to-end through real SQL
 * (not stubs). Tests the same operations as chain-db.test.ts but
 * backed by ChainDBLive instead of an in-memory mock.
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { layer as layerBunSqlClient } from "@effect/sql-sqlite-bun/SqliteClient";
import { type BlobEntry, BlobStore } from "../blob-store/service.ts";
import { ChainDB } from "../services/chain-db.ts";
import { ChainDBLive } from "../services/chain-db-live.ts";
import { LedgerSnapshotStore, LedgerSnapshotStoreLive } from "../services/ledger-snapshot-store.ts";
import { runMigrations } from "../operations/migrations.ts";
import type { StoredBlock } from "../types/StoredBlock.ts";

// ---------------------------------------------------------------------------
// Test layer: in-memory SQLite + in-memory BlobStore → ChainDBLive
// ---------------------------------------------------------------------------

const sqlLayer = layerBunSqlClient({ filename: ":memory:" });

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
    scan: (prefix: Uint8Array) =>
      Stream.fromIterable(
        [...store.entries()]
          .filter(([k]) => {
            const keyBytes = Uint8Array.fromHex(k);
            return keyBytes.length >= prefix.length && prefix.every((b, i) => keyBytes[i] === b);
          })
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => ({ key: Uint8Array.fromHex(k), value: v })),
      ),
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
const storageLayer = Layer.merge(sqlLayer, blobLayer);
const servicesLayer = Layer.merge(ChainDBLive, LedgerSnapshotStoreLive);
const fullLayer = Layer.provideMerge(servicesLayer, storageLayer);

/** Provide a ChainDB + LedgerSnapshotStore effect with fresh migrations + real SQLite. */
const provide = <A>(effect: Effect.Effect<A, unknown, ChainDB | LedgerSnapshotStore>) =>
  runMigrations.pipe(Effect.andThen(effect), Effect.provide(fullLayer));

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChainDBLive with real SQLite", () => {
  it.effect("addBlock + getBlock round-trip", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        const block = makeBlock(100n, 50n);
        yield* db.addBlock(block);
        const result = yield* db.getBlock(block.hash);

        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) {
          expect(result.value.slot).toBe(100n);
          expect(result.value.blockNo).toBe(50n);
          expect(result.value.blockCbor).toEqual(block.blockCbor);
        }
      }),
    ),
  );

  it.effect("getTip returns highest slot", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        yield* db.addBlock(makeBlock(100n, 50n));
        yield* db.addBlock(makeBlock(300n, 150n));
        yield* db.addBlock(makeBlock(200n, 100n));

        const tip = yield* db.getTip;
        expect(Option.isSome(tip)).toBe(true);
        if (Option.isSome(tip)) {
          expect(tip.value.slot).toBe(300n);
        }
      }),
    ),
  );

  it.effect("rollback removes volatile blocks after point", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        const b1 = makeBlock(100n, 50n);
        const b2 = makeBlock(200n, 100n);
        const b3 = makeBlock(300n, 150n);
        yield* db.addBlock(b1);
        yield* db.addBlock(b2);
        yield* db.addBlock(b3);

        yield* db.rollback({ slot: 150n, hash: new Uint8Array(32) });

        const tip = yield* db.getTip;
        expect(Option.isSome(tip)).toBe(true);
        if (Option.isSome(tip)) {
          expect(tip.value.slot).toBe(100n);
        }
      }),
    ),
  );

  it.effect("getSuccessors finds child blocks", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* ChainDB;
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

        yield* db.addBlock(parent);
        yield* db.addBlock(child1);
        yield* db.addBlock(child2);

        const succs = yield* db.getSuccessors(parent.hash);
        expect(succs.length).toBe(2);
      }),
    ),
  );

  it.effect("garbageCollect removes old volatile blocks", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* ChainDB;
        yield* db.addBlock(makeBlock(100n, 50n));
        yield* db.addBlock(makeBlock(200n, 100n));
        yield* db.addBlock(makeBlock(300n, 150n));

        yield* db.garbageCollect(250n);

        const r100 = yield* db.getBlock(makeBlock(100n, 50n).hash);
        const r200 = yield* db.getBlock(makeBlock(200n, 100n).hash);
        const r300 = yield* db.getBlock(makeBlock(300n, 150n).hash);
        expect(Option.isNone(r100)).toBe(true);
        expect(Option.isNone(r200)).toBe(true);
        expect(Option.isSome(r300)).toBe(true);
      }),
    ),
  );

  it.effect("ledger snapshot write + read round-trip", () =>
    provide(
      Effect.gen(function* () {
        const snapshots = yield* LedgerSnapshotStore;
        yield* snapshots.writeLedgerSnapshot(
          100n,
          new Uint8Array(32).fill(0xaa),
          5n,
          new Uint8Array([1, 2, 3]),
        );

        const result = yield* snapshots.readLatestLedgerSnapshot;
        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) {
          expect(result.value.point.slot).toBe(100n);
          expect(result.value.epoch).toBe(5n);
          expect(result.value.stateBytes).toEqual(new Uint8Array([1, 2, 3]));
        }
      }),
    ),
  );
});
