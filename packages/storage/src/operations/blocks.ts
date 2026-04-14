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

export const writeImmutableBlock = (block: StoredBlock) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const store = yield* BlobStore;
    const now = yield* Clock.currentTimeMillis;
    const time = Math.floor(Number(now) / 1000);

    yield* sql.withTransaction(
      Effect.all(
        [
          store.put(blockKey(block.slot, block.hash), block.blockCbor),
          sql`
            INSERT INTO immutable_blocks (slot, hash, prev_hash, block_no, epoch_no, size, time, slot_leader_id, proto_major, proto_minor)
            VALUES (${Number(block.slot)}, ${block.hash}, ${block.prevHash ?? null}, ${Number(block.blockNo)}, ${0}, ${block.blockSizeBytes}, ${time}, ${0}, ${0}, ${0})
            ON CONFLICT (slot) DO UPDATE SET hash = ${block.hash}
          `.unprepared,
        ],
        { concurrency: "unbounded" },
      ),
    );
  }).pipe(Effect.mapError((cause) => new ImmutableDBError({ operation: "writeBlock", cause })));

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

export const writeVolatileBlock = (block: StoredBlock) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const store = yield* BlobStore;

    yield* sql.withTransaction(
      Effect.all(
        [
          store.put(blockKey(block.slot, block.hash), block.blockCbor),
          sql`
            INSERT INTO volatile_blocks (hash, slot, prev_hash, block_no, block_size_bytes)
            VALUES (${block.hash}, ${Number(block.slot)}, ${block.prevHash ?? null}, ${Number(block.blockNo)}, ${block.blockSizeBytes})
            ON CONFLICT (hash) DO NOTHING
          `.unprepared,
        ],
        { concurrency: "unbounded" },
      ),
    );
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "writeBlock", cause })));

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
