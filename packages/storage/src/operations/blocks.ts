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
// Row schemas — one unified shape for both layers. The physical column name
// differs (`immutable_blocks.size` vs `volatile_blocks.block_size_bytes`);
// every immutable SELECT aliases `size AS block_size_bytes` so the decoded
// row shape matches exactly. One schema + one row-reader covers both tables.
//
// Exported because `services/chain-db-live.ts` consumes the same shape (with
// the same alias convention) across ~8 internal query builders — exporting
// here keeps the alias invariant documented in one place.
// ---------------------------------------------------------------------------

export const BlockRow = Schema.Struct({
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
// Shared defaults for `immutable_blocks` inserts.
//
// Gerolamino doesn't (yet) track these per-block; future migrations may
// populate them from block header decoding. Centralising the constant
// keeps `writeImmutableBlocks` + the lifecycle reactor's
// `promoteBlocksEffect` in sync — a change here is picked up by both.
// ---------------------------------------------------------------------------

export const IMMUTABLE_BLOCK_DEFAULTS = {
  epoch_no: 0,
  slot_leader_id: 0,
  proto_major: 0,
  proto_minor: 0,
} as const;

/** Unix-seconds wall clock — shared by every `time`-stamped write. */
export const timeUnixSeconds: Effect.Effect<number> = Effect.map(Clock.currentTimeMillis, (ms) =>
  Math.floor(Number(ms) / 1000),
);

/** Lift a decoded `BlockRow` + its freshly-fetched CBOR into a `StoredBlock`.
 *  Shared between `readImmutableBlock` / `readVolatileBlock` (here) and
 *  `services/chain-db-live.ts::readBlockFromRow` so the three read paths
 *  can't drift on field naming / optional-prevHash handling. */
export const toStoredBlock = (r: typeof BlockRow.Type, blockCbor: Uint8Array): StoredBlock => ({
  slot: BigInt(r.slot),
  hash: r.hash,
  blockNo: BigInt(r.block_no),
  blockSizeBytes: r.block_size_bytes,
  blockCbor,
  ...(r.prev_hash ? { prevHash: r.prev_hash } : {}),
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
    const time = yield* timeUnixSeconds;
    const rows = blocks.map((b) => ({
      slot: Number(b.slot),
      hash: b.hash,
      prev_hash: b.prevHash ?? null,
      block_no: Number(b.blockNo),
      size: b.blockSizeBytes,
      time,
      ...IMMUTABLE_BLOCK_DEFAULTS,
    }));

    yield* sql.withTransaction(
      Effect.all(
        [
          // Blob puts fan out; they're independent keys.
          Effect.forEach(blocks, (b) => store.put(blockKey(b.slot, b.hash), b.blockCbor), {
            concurrency: "unbounded",
            discard: true,
          }),
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
      Result: BlockRow,
      execute: (req) => sql`
        SELECT slot, hash, prev_hash, block_no, size AS block_size_bytes
        FROM immutable_blocks
        WHERE slot = ${req.slot} AND hash = ${req.hash}
        LIMIT 1
      `,
    });
    const rowOpt = yield* findBlock({ slot: Number(point.slot), hash: point.hash });
    if (Option.isNone(rowOpt)) return Option.none<StoredBlock>();
    const r = rowOpt.value;
    const cborOpt = yield* store.get(blockKey(point.slot, point.hash));
    return Option.map(cborOpt, (blockCbor) => toStoredBlock(r, blockCbor));
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
          Effect.forEach(blocks, (b) => store.put(blockKey(b.slot, b.hash), b.blockCbor), {
            concurrency: "unbounded",
            discard: true,
          }),
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
      Result: BlockRow,
      execute: (req) => sql`
        SELECT hash, slot, prev_hash, block_no, block_size_bytes
        FROM volatile_blocks
        WHERE hash = ${req.hash}
        LIMIT 1
      `,
    });
    const rowOpt = yield* findBlock({ hash });
    if (Option.isNone(rowOpt)) return Option.none<StoredBlock>();
    const r = rowOpt.value;
    const cborOpt = yield* store.get(blockKey(BigInt(r.slot), r.hash));
    return Option.map(cborOpt, (blockCbor) => toStoredBlock(r, blockCbor));
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

    const findToDelete = SqlSchema.findAll({
      Request: Schema.Struct({ belowSlot: Schema.Number }),
      Result: PointRow,
      execute: (req) => sql`
        SELECT slot, hash FROM volatile_blocks WHERE slot < ${req.belowSlot}
      `,
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* findToDelete({ belowSlot });
        if (rows.length > 0) {
          yield* store.deleteBatch(rows.map((r) => blockKey(BigInt(r.slot), r.hash)));
        }
        yield* sql`DELETE FROM volatile_blocks WHERE slot < ${belowSlot}`;
      }),
    );
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "garbageCollect", cause })));

