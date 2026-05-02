/**
 * Block storage operations — dual-layer architecture.
 *
 * Metadata (slot, hash, blockNo, epoch, size) stays in SQL via Drizzle's
 * query builder over the abstract `SqlClient`. Block CBOR blobs move to
 * BlobStore (LSM in Bun, IndexedDB in browser).
 *
 * Both layers are accessed via Effect services — consumer code never
 * imports platform-specific modules.
 */
import { Clock, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { and, desc, eq, lt, sql as sqlExpr } from "drizzle-orm";
import { StoredBlock, RealPoint } from "../types/StoredBlock";
import { ImmutableDBError, VolatileDBError } from "../errors";
import { BlobStore, blockKey } from "../blob-store";
import { immutableBlocks, volatileBlocks } from "../schema/index.ts";
import { compile, db } from "../services/drizzle.ts";

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
  epochNo: 0,
  slotLeaderId: 0,
  protoMajor: 0,
  protoMinor: 0,
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
      prevHash: b.prevHash ?? null,
      blockNo: Number(b.blockNo),
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
          // Single multi-row INSERT via Drizzle's bulk-insert builder.
          // UPSERT on slot conflict.
          compile(
            sql,
            db
              .insert(immutableBlocks)
              .values(rows)
              .onConflictDoUpdate({
                target: immutableBlocks.slot,
                set: { hash: sqlExpr`excluded.hash` },
              }),
          ),
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
      // We bypass Drizzle's session-side result re-mapping (since we
      // execute via Effect's `SqlClient.unsafe`), so the rows that come
      // back use the *SQL* column names. The selection therefore needs
      // explicit `AS` aliases via `sqlExpr` for any column whose JS
      // schema name differs from its SQL name (here: `size` →
      // `block_size_bytes`, matching the unified volatile-blocks shape).
      execute: (req) =>
        compile(
          sql,
          db
            .select({
              slot: immutableBlocks.slot,
              hash: immutableBlocks.hash,
              prev_hash: immutableBlocks.prevHash,
              block_no: immutableBlocks.blockNo,
              block_size_bytes: sqlExpr<number>`${immutableBlocks.size}`.as("block_size_bytes"),
            })
            .from(immutableBlocks)
            .where(and(eq(immutableBlocks.slot, req.slot), eq(immutableBlocks.hash, req.hash)))
            .limit(1),
        ),
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
    execute: () =>
      compile(
        sql,
        db
          .select({ slot: immutableBlocks.slot, hash: immutableBlocks.hash })
          .from(immutableBlocks)
          .orderBy(desc(immutableBlocks.slot))
          .limit(1),
      ),
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
      prevHash: b.prevHash ?? null,
      blockNo: Number(b.blockNo),
      blockSizeBytes: b.blockSizeBytes,
    }));

    yield* sql.withTransaction(
      Effect.all(
        [
          Effect.forEach(blocks, (b) => store.put(blockKey(b.slot, b.hash), b.blockCbor), {
            concurrency: "unbounded",
            discard: true,
          }),
          compile(
            sql,
            db
              .insert(volatileBlocks)
              .values(rows)
              .onConflictDoNothing({ target: volatileBlocks.hash }),
          ),
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
      execute: (req) =>
        compile(
          sql,
          db
            .select({
              hash: volatileBlocks.hash,
              slot: volatileBlocks.slot,
              prev_hash: volatileBlocks.prevHash,
              block_no: volatileBlocks.blockNo,
              block_size_bytes: volatileBlocks.blockSizeBytes,
            })
            .from(volatileBlocks)
            .where(eq(volatileBlocks.hash, req.hash))
            .limit(1),
        ),
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
      execute: (req) =>
        compile(
          sql,
          db
            .select({ hash: volatileBlocks.hash })
            .from(volatileBlocks)
            .where(eq(volatileBlocks.prevHash, req.hash)),
        ),
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
      execute: (req) =>
        compile(
          sql,
          db
            .select({ slot: volatileBlocks.slot, hash: volatileBlocks.hash })
            .from(volatileBlocks)
            .where(lt(volatileBlocks.slot, req.belowSlot)),
        ),
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* findToDelete({ belowSlot });
        if (rows.length > 0) {
          yield* store.deleteBatch(rows.map((r) => blockKey(BigInt(r.slot), r.hash)));
        }
        yield* compile(sql, db.delete(volatileBlocks).where(lt(volatileBlocks.slot, belowSlot)));
      }),
    );
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "garbageCollect", cause })));
