/**
 * Block storage operations — dual-layer architecture.
 *
 * Metadata (slot, hash, blockNo, epoch, size) stays in SQL (Effect SqlClient).
 * Block CBOR blobs move to BlobStore (LSM in Bun, IndexedDB in browser).
 *
 * Both layers are accessed via Effect services — consumer code never
 * imports platform-specific modules.
 */
import { Clock, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { StoredBlock, RealPoint } from "../types/StoredBlock";
import { ImmutableDBError, VolatileDBError } from "../errors";
import { BlobStore, blockKey } from "../blob-store";

// ---------------------------------------------------------------------------
// Row schemas — type-safe SQL result decoding (no `as Type` casts)
// ---------------------------------------------------------------------------

const ImmutableBlockRow = Schema.Struct({
  slot: Schema.Number,
  hash: Schema.Uint8Array,
  prev_hash: Schema.NullOr(Schema.Uint8Array),
  block_no: Schema.Number,
  size: Schema.Number,
});

const VolatileBlockRow = Schema.Struct({
  hash: Schema.Uint8Array,
  slot: Schema.Number,
  prev_hash: Schema.NullOr(Schema.Uint8Array),
  block_no: Schema.Number,
  block_size_bytes: Schema.Number,
});

const PointRow = Schema.Struct({
  slot: Schema.Number,
  hash: Schema.Uint8Array,
});

// ---------------------------------------------------------------------------
// Immutable block operations
// ---------------------------------------------------------------------------

export const writeImmutableBlock = (block: StoredBlock) => writeImmutableBlocks([block]);

export const writeImmutableBlocks = (blocks: ReadonlyArray<StoredBlock>) =>
  Effect.gen(function* () {
    if (blocks.length === 0) return;
    const sql = yield* SqlClient;
    const store = yield* BlobStore;
    const now = yield* Clock.currentTimeMillis;
    const time = Math.floor(Number(now) / 1000);
    const rows = blocks.map((b) => ({
      slot: Number(b.slot),
      hash: b.hash,
      prev_hash: b.prevHash ?? null,
      block_no: Number(b.blockNo),
      epoch_no: 0,
      size: b.blockSizeBytes,
      time,
      slot_leader_id: 0,
      proto_major: 0,
      proto_minor: 0,
    }));

    yield* sql.withTransaction(
      Effect.all(
        [
          // Blob puts fan out; they're independent keys.
          Effect.forEach(
            blocks,
            (b) => store.put(blockKey(b.slot, b.hash), b.blockCbor),
            { concurrency: "unbounded", discard: true },
          ),
          // Single multi-row INSERT via `sql.insert` (Effect Statement.ts:368)
          // collapses N round-trips into 1. UPSERT on slot conflict.
          sql`INSERT INTO immutable_blocks ${sql.insert(rows)}
              ON CONFLICT(slot) DO UPDATE SET hash = excluded.hash`,
        ],
        { concurrency: "unbounded" },
      ),
    );
  }).pipe(Effect.mapError((cause) => new ImmutableDBError({ operation: "writeBlocks", cause })));

export const readImmutableBlock = (point: RealPoint) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const store = yield* BlobStore;

    const findBlock = SqlSchema.findOneOption({
      Request: Schema.Struct({ slot: Schema.Number, hash: Schema.Uint8Array }),
      Result: ImmutableBlockRow,
      execute: (req) => sql`
        SELECT slot, hash, prev_hash, block_no, size
        FROM immutable_blocks
        WHERE slot = ${req.slot} AND hash = ${req.hash}
        LIMIT 1
      `,
    });

    const row = yield* findBlock({ slot: Number(point.slot), hash: point.hash });
    if (Option.isNone(row)) return Option.none<StoredBlock>();

    const r = row.value;
    const blockCbor = yield* store.get(blockKey(point.slot, point.hash));
    if (Option.isNone(blockCbor)) return Option.none<StoredBlock>();

    return Option.some<StoredBlock>({
      slot: BigInt(r.slot),
      hash: r.hash,
      blockNo: BigInt(r.block_no),
      blockSizeBytes: r.size,
      blockCbor: blockCbor.value,
      ...(r.prev_hash ? { prevHash: r.prev_hash } : {}),
    });
  }).pipe(Effect.mapError((cause) => new ImmutableDBError({ operation: "readBlock", cause })));

export const getImmutableTip = Effect.gen(function* () {
  const sql = yield* SqlClient;

  const findTip = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: PointRow,
    execute: () => sql`
      SELECT slot, hash FROM immutable_blocks
      ORDER BY slot DESC LIMIT 1
    `,
  });

  const row = yield* findTip(undefined);
  return Option.map(row, (r) => ({ slot: BigInt(r.slot), hash: r.hash }) satisfies RealPoint);
}).pipe(Effect.mapError((cause) => new ImmutableDBError({ operation: "getTip", cause })));

// ---------------------------------------------------------------------------
// Volatile block operations
// ---------------------------------------------------------------------------

export const writeVolatileBlock = (block: StoredBlock) => writeVolatileBlocks([block]);

export const writeVolatileBlocks = (blocks: ReadonlyArray<StoredBlock>) =>
  Effect.gen(function* () {
    if (blocks.length === 0) return;
    const sql = yield* SqlClient;
    const store = yield* BlobStore;
    const rows = blocks.map((b) => ({
      hash: b.hash,
      slot: Number(b.slot),
      prev_hash: b.prevHash ?? null,
      block_no: Number(b.blockNo),
      block_size_bytes: b.blockSizeBytes,
    }));

    yield* sql.withTransaction(
      Effect.all(
        [
          Effect.forEach(
            blocks,
            (b) => store.put(blockKey(b.slot, b.hash), b.blockCbor),
            { concurrency: "unbounded", discard: true },
          ),
          sql`INSERT INTO volatile_blocks ${sql.insert(rows)}
              ON CONFLICT(hash) DO NOTHING`,
        ],
        { concurrency: "unbounded" },
      ),
    );
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "writeBlocks", cause })));

export const readVolatileBlock = (hash: Uint8Array) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const store = yield* BlobStore;

    const findBlock = SqlSchema.findOneOption({
      Request: Schema.Struct({ hash: Schema.Uint8Array }),
      Result: VolatileBlockRow,
      execute: (req) => sql`
        SELECT hash, slot, prev_hash, block_no, block_size_bytes
        FROM volatile_blocks
        WHERE hash = ${req.hash}
        LIMIT 1
      `,
    });

    const row = yield* findBlock({ hash });
    if (Option.isNone(row)) return Option.none<StoredBlock>();

    const r = row.value;
    const blockCbor = yield* store.get(blockKey(BigInt(r.slot), r.hash));
    if (Option.isNone(blockCbor)) return Option.none<StoredBlock>();

    return Option.some<StoredBlock>({
      slot: BigInt(r.slot),
      hash: r.hash,
      blockNo: BigInt(r.block_no),
      blockSizeBytes: r.block_size_bytes,
      blockCbor: blockCbor.value,
      ...(r.prev_hash ? { prevHash: r.prev_hash } : {}),
    });
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "readBlock", cause })));

export const getVolatileSuccessors = (hash: Uint8Array) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const findSuccessors = SqlSchema.findAll({
      Request: Schema.Struct({ hash: Schema.Uint8Array }),
      Result: Schema.Struct({ hash: Schema.Uint8Array }),
      execute: (req) => sql`
        SELECT hash FROM volatile_blocks WHERE prev_hash = ${req.hash}
      `,
    });

    const rows = yield* findSuccessors({ hash });
    return rows.map((r) => r.hash);
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "getSuccessors", cause })));

export const garbageCollectVolatile = (belowSlot: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const store = yield* BlobStore;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        const findToDelete = SqlSchema.findAll({
          Request: Schema.Struct({ belowSlot: Schema.Number }),
          Result: PointRow,
          execute: (req) => sql`
            SELECT slot, hash FROM volatile_blocks WHERE slot < ${req.belowSlot}
          `,
        });

        const rows = yield* findToDelete({ belowSlot });
        if (rows.length > 0) {
          yield* store.deleteBatch(rows.map((r) => blockKey(BigInt(r.slot), r.hash)));
        }
        yield* sql`DELETE FROM volatile_blocks WHERE slot < ${belowSlot}`.unprepared;
      }),
    );
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "garbageCollect", cause })));
