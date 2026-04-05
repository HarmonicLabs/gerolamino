/**
 * Block storage operations — using Drizzle ORM query builder.
 *
 * All operations use the SqliteDrizzle service and the `query` helper
 * to bridge Drizzle's Promise API into Effect.
 */
import { Effect } from "effect";
import { eq, and, lt, desc } from "drizzle-orm";
import { SqliteDrizzle, query, schema } from "../db/client.ts";
import type { StoredBlock, RealPoint } from "../types/StoredBlock.ts";
import { ImmutableDBError, VolatileDBError } from "../errors.ts";

// ---------------------------------------------------------------------------
// Immutable block operations
// ---------------------------------------------------------------------------

export const writeImmutableBlock = (block: StoredBlock) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
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
          blockCbor: block.blockCbor,
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
    return {
      slot: BigInt(r.slot),
      hash: r.hash,
      prevHash: r.prevHash ?? undefined,
      blockNo: BigInt(r.blockNo),
      blockSizeBytes: r.size,
      blockCbor: r.blockCbor,
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
    yield* query(
      db
        .insert(schema.volatileBlocks)
        .values({
          hash: block.hash,
          slot: Number(block.slot),
          prevHash: block.prevHash ?? null,
          blockNo: Number(block.blockNo),
          blockSizeBytes: block.blockSizeBytes,
          blockCbor: block.blockCbor,
        })
        .onConflictDoNothing({ target: schema.volatileBlocks.hash }),
    );
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "writeBlock", cause })));

export const readVolatileBlock = (hash: Uint8Array) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const rows = yield* query(
      db.select().from(schema.volatileBlocks).where(eq(schema.volatileBlocks.hash, hash)).limit(1),
    );
    if (rows.length === 0) return undefined;
    const r = rows[0]!;
    return {
      slot: BigInt(r.slot),
      hash: r.hash,
      prevHash: r.prevHash ?? undefined,
      blockNo: BigInt(r.blockNo),
      blockSizeBytes: r.blockSizeBytes,
      blockCbor: r.blockCbor,
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
    yield* query(db.delete(schema.volatileBlocks).where(lt(schema.volatileBlocks.slot, belowSlot)));
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "garbageCollect", cause })));
