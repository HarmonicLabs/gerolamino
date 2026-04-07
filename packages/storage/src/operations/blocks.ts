/**
 * Block storage operations — dual-layer architecture.
 *
 * Metadata (slot, hash, blockNo, epoch, size) stays in SQL (Drizzle ORM).
 * Block CBOR blobs move to BlobStore (LSM in Bun, IndexedDB in browser).
 *
 * Both layers are accessed via Effect services — consumer code never
 * imports platform-specific modules.
 */
import { Effect } from "effect";
import { eq, and, lt, desc } from "drizzle-orm";
import { SqliteDrizzle, query, schema } from "../db/client";
import type { StoredBlock, RealPoint } from "../types/StoredBlock";
import { ImmutableDBError, VolatileDBError } from "../errors";
import { BlobStore, blockKey } from "../blob-store/index.ts";

// ---------------------------------------------------------------------------
// Immutable block operations
// ---------------------------------------------------------------------------

export const writeImmutableBlock = (block: StoredBlock) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const store = yield* BlobStore;

    // Write CBOR blob to BlobStore
    yield* store.put(
      blockKey(block.slot, block.hash),
      block.blockCbor,
    );

    // Write metadata to SQL (no blockCbor column)
    yield* query(
      db
        .insert(schema.immutableBlocks)
        .values({
          slot: Number(block.slot),
          hash: block.hash,
          prevHash: block.prevHash ?? null,
          blockNo: Number(block.blockNo),
          epochNo: 0,
          size: block.blockSizeBytes,
          time: Math.floor(Date.now() / 1000),
          slotLeaderId: 0,
          protoMajor: 0,
          protoMinor: 0,
        })
        .onConflictDoUpdate({
          target: schema.immutableBlocks.slot,
          set: { hash: block.hash },
        }),
    );
  }).pipe(Effect.mapError((cause) => new ImmutableDBError({ operation: "writeBlock", cause })));

export const readImmutableBlock = (point: RealPoint) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const store = yield* BlobStore;

    // Read metadata from SQL
    const rows = yield* query(
      db
        .select()
        .from(schema.immutableBlocks)
        .where(
          and(
            eq(schema.immutableBlocks.slot, Number(point.slot)),
            eq(schema.immutableBlocks.hash, point.hash),
          ),
        )
        .limit(1),
    );
    if (rows.length === 0) return undefined;
    const r = rows[0]!;

    // Read CBOR blob from BlobStore
    const blockCbor = yield* store.get(blockKey(point.slot, point.hash));
    if (blockCbor === undefined) return undefined;

    return {
      slot: BigInt(r.slot),
      hash: r.hash,
      prevHash: r.prevHash ?? undefined,
      blockNo: BigInt(r.blockNo),
      blockSizeBytes: r.size,
      blockCbor,
    } satisfies StoredBlock;
  }).pipe(Effect.mapError((cause) => new ImmutableDBError({ operation: "readBlock", cause })));

export const getImmutableTip = Effect.gen(function* () {
  const db = yield* SqliteDrizzle;
  const rows = yield* query(
    db
      .select({
        slot: schema.immutableBlocks.slot,
        hash: schema.immutableBlocks.hash,
      })
      .from(schema.immutableBlocks)
      .orderBy(desc(schema.immutableBlocks.slot))
      .limit(1),
  );
  if (rows.length === 0) return undefined;
  return {
    slot: BigInt(rows[0]!.slot),
    hash: rows[0]!.hash,
  } satisfies RealPoint;
}).pipe(Effect.mapError((cause) => new ImmutableDBError({ operation: "getTip", cause })));

// ---------------------------------------------------------------------------
// Volatile block operations
// ---------------------------------------------------------------------------

export const writeVolatileBlock = (block: StoredBlock) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const store = yield* BlobStore;

    // Write CBOR blob to BlobStore
    yield* store.put(
      blockKey(block.slot, block.hash),
      block.blockCbor,
    );

    // Write metadata to SQL (no blockCbor column)
    yield* query(
      db
        .insert(schema.volatileBlocks)
        .values({
          hash: block.hash,
          slot: Number(block.slot),
          prevHash: block.prevHash ?? null,
          blockNo: Number(block.blockNo),
          blockSizeBytes: block.blockSizeBytes,
        })
        .onConflictDoNothing({ target: schema.volatileBlocks.hash }),
    );
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "writeBlock", cause })));

export const readVolatileBlock = (hash: Uint8Array) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const store = yield* BlobStore;

    const rows = yield* query(
      db.select().from(schema.volatileBlocks).where(eq(schema.volatileBlocks.hash, hash)).limit(1),
    );
    if (rows.length === 0) return undefined;
    const r = rows[0]!;

    // Read CBOR blob from BlobStore
    const blockCbor = yield* store.get(blockKey(BigInt(r.slot), r.hash));
    if (blockCbor === undefined) return undefined;

    return {
      slot: BigInt(r.slot),
      hash: r.hash,
      prevHash: r.prevHash ?? undefined,
      blockNo: BigInt(r.blockNo),
      blockSizeBytes: r.blockSizeBytes,
      blockCbor,
    } satisfies StoredBlock;
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "readBlock", cause })));

export const getVolatileSuccessors = (hash: Uint8Array) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const rows = yield* query(
      db
        .select({ hash: schema.volatileBlocks.hash })
        .from(schema.volatileBlocks)
        .where(eq(schema.volatileBlocks.prevHash, hash)),
    );
    return rows.map((r) => r.hash);
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "getSuccessors", cause })));

export const garbageCollectVolatile = (belowSlot: number) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const store = yield* BlobStore;

    // Find blocks to delete so we can clean up BlobStore entries
    const toDelete = yield* query(
      db.select({ slot: schema.volatileBlocks.slot, hash: schema.volatileBlocks.hash })
        .from(schema.volatileBlocks)
        .where(lt(schema.volatileBlocks.slot, belowSlot)),
    );

    // Delete BlobStore entries for GC'd blocks
    if (toDelete.length > 0) {
      yield* store.deleteBatch(
        toDelete.map((r) => blockKey(BigInt(r.slot), r.hash)),
      );
    }

    // Delete SQL rows
    yield* query(db.delete(schema.volatileBlocks).where(lt(schema.volatileBlocks.slot, belowSlot)));
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "garbageCollect", cause })));
