/**
 * Block storage operations — abstract over SqlClient.
 */
import { Effect, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { StoredBlock, RealPoint } from "../types/StoredBlock.ts";
import { ImmutableDBError, VolatileDBError } from "../errors.ts";

// ---------------------------------------------------------------------------
// Immutable block operations
// ---------------------------------------------------------------------------

export const writeImmutableBlock = (block: StoredBlock) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO immutable_blocks (slot, hash, prev_hash, block_no, block_size_bytes, block_cbor)
      VALUES (${Number(block.slot)}, ${block.hash}, ${block.prevHash ?? null},
              ${Number(block.blockNo)}, ${block.blockSizeBytes}, ${block.blockCbor})
      ON CONFLICT(slot) DO UPDATE SET hash = ${block.hash}
    `;
  }).pipe(Effect.mapError((cause) => new ImmutableDBError({ operation: "writeBlock", cause })));

export const readImmutableBlock = (point: RealPoint) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      slot: number;
      hash: Uint8Array;
      prev_hash: Uint8Array | null;
      block_no: number;
      block_size_bytes: number;
      block_cbor: Uint8Array;
    }>`SELECT * FROM immutable_blocks WHERE slot = ${Number(point.slot)} AND hash = ${point.hash}`;
    if (rows.length === 0) return undefined;
    const r = rows[0]!;
    return {
      slot: BigInt(r.slot),
      hash: r.hash,
      prevHash: r.prev_hash ?? undefined,
      blockNo: BigInt(r.block_no),
      blockSizeBytes: r.block_size_bytes,
      blockCbor: r.block_cbor,
    } satisfies StoredBlock;
  }).pipe(Effect.mapError((cause) => new ImmutableDBError({ operation: "readBlock", cause })));

export const getImmutableTip = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ slot: number; hash: Uint8Array }>`
    SELECT slot, hash FROM immutable_blocks ORDER BY slot DESC LIMIT 1
  `;
  if (rows.length === 0) return undefined;
  return { slot: BigInt(rows[0]!.slot), hash: rows[0]!.hash } satisfies RealPoint;
}).pipe(Effect.mapError((cause) => new ImmutableDBError({ operation: "getTip", cause })));

// ---------------------------------------------------------------------------
// Volatile block operations
// ---------------------------------------------------------------------------

export const writeVolatileBlock = (block: StoredBlock) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO volatile_blocks (hash, slot, prev_hash, block_no, block_size_bytes, block_cbor)
      VALUES (${block.hash}, ${Number(block.slot)}, ${block.prevHash ?? null},
              ${Number(block.blockNo)}, ${block.blockSizeBytes}, ${block.blockCbor})
      ON CONFLICT(hash) DO NOTHING
    `;
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "writeBlock", cause })));

export const readVolatileBlock = (hash: Uint8Array) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      hash: Uint8Array;
      slot: number;
      prev_hash: Uint8Array | null;
      block_no: number;
      block_size_bytes: number;
      block_cbor: Uint8Array;
    }>`SELECT * FROM volatile_blocks WHERE hash = ${hash}`;
    if (rows.length === 0) return undefined;
    const r = rows[0]!;
    return {
      slot: BigInt(r.slot),
      hash: r.hash,
      prevHash: r.prev_hash ?? undefined,
      blockNo: BigInt(r.block_no),
      blockSizeBytes: r.block_size_bytes,
      blockCbor: r.block_cbor,
    } satisfies StoredBlock;
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "readBlock", cause })));

export const getVolatileSuccessors = (hash: Uint8Array) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ hash: Uint8Array }>`
      SELECT hash FROM volatile_blocks WHERE prev_hash = ${hash}
    `;
    return rows.map((r) => r.hash);
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "getSuccessors", cause })));

export const garbageCollectVolatile = (belowSlot: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`DELETE FROM volatile_blocks WHERE slot < ${belowSlot}`;
  }).pipe(Effect.mapError((cause) => new VolatileDBError({ operation: "garbageCollect", cause })));
