/**
 * Block storage operations — dual-layer architecture.
 *
 * Metadata (slot, hash, blockNo, epoch, size) stays in SQL (Drizzle ORM).
 * Block CBOR blobs move to BlobStore (LSM in Bun, IndexedDB in browser).
 *
 * Both layers are accessed via Effect services — consumer code never
 * imports platform-specific modules.
 */
import { Clock, Effect } from "effect";
import { eq, and, lt, desc } from "drizzle-orm";
import { SqliteDrizzle, query, schema } from "../db/client";
import type { StoredBlock, RealPoint } from "../types/StoredBlock";
import { ImmutableDBError, VolatileDBError } from "../errors";
import { BlobStore, blockKey } from "../blob-store/index.ts";

/** Convert Uint8Array to Buffer for Drizzle blob columns. */
const buf = (data: Uint8Array): Buffer => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

/** Convert Buffer from Drizzle back to plain Uint8Array for domain types. */
const u8 = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

// ---------------------------------------------------------------------------
// Immutable block operations
// ---------------------------------------------------------------------------

export const writeImmutableBlock = (block: StoredBlock) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const store = yield* BlobStore;
    const now = yield* Clock.currentTimeMillis;

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
          hash: buf(block.hash),
          prevHash: block.prevHash ? buf(block.prevHash) : null,
          blockNo: Number(block.blockNo),
          epochNo: 0,
          size: block.blockSizeBytes,
          time: Math.floor(Number(now) / 1000),
          slotLeaderId: 0,
          protoMajor: 0,
          protoMinor: 0,
        })
        .onConflictDoUpdate({
          target: schema.immutableBlocks.slot,
          set: { hash: buf(block.hash) },
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
            eq(schema.immutableBlocks.hash, buf(point.hash)),
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
      hash: u8(r.hash),
      blockNo: BigInt(r.blockNo),
      blockSizeBytes: r.size,
      blockCbor,
      ...(r.prevHash ? { prevHash: u8(r.prevHash) } : {}),
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
    hash: u8(rows[0]!.hash),
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
          hash: buf(block.hash),
          slot: Number(block.slot),
          prevHash: block.prevHash ? buf(block.prevHash) : null,
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
      db.select().from(schema.volatileBlocks).where(eq(schema.volatileBlocks.hash, buf(hash))).limit(1),
    );
    if (rows.length === 0) return undefined;
    const r = rows[0]!;

    // Read CBOR blob from BlobStore
    const blockCbor = yield* store.get(blockKey(BigInt(r.slot), r.hash));
    if (blockCbor === undefined) return undefined;

    return {
      slot: BigInt(r.slot),
      hash: u8(r.hash),
      blockNo: BigInt(r.blockNo),
      blockSizeBytes: r.blockSizeBytes,
      blockCbor,
      ...(r.prevHash ? { prevHash: u8(r.prevHash) } : {}),
    } satisfies StoredBlock;
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "readBlock", cause })));

export const getVolatileSuccessors = (hash: Uint8Array) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const rows = yield* query(
      db
        .select({ hash: schema.volatileBlocks.hash })
        .from(schema.volatileBlocks)
        .where(eq(schema.volatileBlocks.prevHash, buf(hash))),
    );
    return rows.map((r) => u8(r.hash));
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
