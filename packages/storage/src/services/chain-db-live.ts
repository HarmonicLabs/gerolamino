/**
 * ChainDB live implementation — backed by BlobStore + SqliteDrizzle.
 *
 * Block CBOR stored in BlobStore under `blk:` prefix.
 * Metadata (slot, hash, prevHash, blockNo) stored in SQL.
 * Ledger state bytes stored in BlobStore under `snap` prefix.
 *
 * Lookups follow spec 12.1.1: try volatile first, then immutable.
 * Rollback removes volatile blocks after the rollback point.
 * GC deletes both SQL rows and BlobStore entries.
 */
import { Clock, Effect, Layer, Stream } from "effect";
import { eq, and, lt, gt, desc, asc } from "drizzle-orm";
import { ChainDB, ChainDBError } from "./chain-db.ts";
import { BlobStore } from "../blob-store/service.ts";
import { blockKey, PREFIX_BLK } from "../blob-store/keys.ts";
import { SqliteDrizzle, query, schema } from "../db/client.ts";
import type { StoredBlock, RealPoint } from "../types/StoredBlock.ts";

const fail = (operation: string, cause: unknown) =>
  new ChainDBError({ operation, cause });

/** BlobStore key for ledger snapshot state bytes. */
const snapshotBlobKey = (slot: bigint): Uint8Array => {
  const prefix = new TextEncoder().encode("snap");
  const buf = new Uint8Array(prefix.length + 8);
  buf.set(prefix);
  new DataView(buf.buffer, buf.byteOffset).setBigUint64(prefix.length, slot);
  return buf;
};

export const ChainDBLive: Layer.Layer<ChainDB, never, BlobStore | SqliteDrizzle> =
  Layer.effect(
    ChainDB,
    Effect.gen(function* () {
      const store = yield* BlobStore;
      const db = yield* SqliteDrizzle;

      const getBlockFromSql = (
        table: typeof schema.volatileBlocks | typeof schema.immutableBlocks,
        where: Parameters<typeof eq>[1],
        hashCol: any,
        slotCol?: any,
        point?: RealPoint,
      ) =>
        Effect.gen(function* () {
          const conditions = point
            ? and(eq(hashCol, point.hash), eq(slotCol, Number(point.slot)))
            : eq(hashCol, where);
          const rows = yield* query(
            db.select().from(table).where(conditions).limit(1),
          );
          if (rows.length === 0) return undefined;
          const r = rows[0]!;
          const blockCbor = yield* store.get(
            blockKey(BigInt(r.slot), r.hash),
          );
          if (blockCbor === undefined) return undefined;
          return {
            slot: BigInt(r.slot),
            hash: r.hash,
            prevHash: r.prevHash ?? undefined,
            blockNo: BigInt(r.blockNo),
            blockSizeBytes: "blockSizeBytes" in r ? r.blockSizeBytes : "size" in r ? r.size : 0,
            blockCbor,
          } satisfies StoredBlock;
        });

      return {
        // --- Lookups (volatile first) ---
        getBlock: (hash: Uint8Array) =>
          Effect.gen(function* () {
            // Try volatile first (spec 12.1.1)
            const volatile = yield* getBlockFromSql(
              schema.volatileBlocks,
              hash,
              schema.volatileBlocks.hash,
            );
            if (volatile) return volatile;
            // Then immutable
            const rows = yield* query(
              db.select().from(schema.immutableBlocks)
                .where(eq(schema.immutableBlocks.hash, hash))
                .limit(1),
            );
            if (rows.length === 0) return undefined;
            const r = rows[0]!;
            const blockCbor = yield* store.get(blockKey(BigInt(r.slot), r.hash));
            if (!blockCbor) return undefined;
            return {
              slot: BigInt(r.slot), hash: r.hash,
              prevHash: r.prevHash ?? undefined,
              blockNo: BigInt(r.blockNo), blockSizeBytes: r.size, blockCbor,
            } satisfies StoredBlock;
          }).pipe(Effect.mapError((c) => fail("getBlock", c))),

        getBlockAt: (point: RealPoint) =>
          Effect.gen(function* () {
            // Try volatile first
            const vRows = yield* query(
              db.select().from(schema.volatileBlocks)
                .where(and(
                  eq(schema.volatileBlocks.hash, point.hash),
                  eq(schema.volatileBlocks.slot, Number(point.slot)),
                )).limit(1),
            );
            if (vRows.length > 0) {
              const r = vRows[0]!;
              const blockCbor = yield* store.get(blockKey(point.slot, point.hash));
              if (blockCbor) return {
                slot: BigInt(r.slot), hash: r.hash,
                prevHash: r.prevHash ?? undefined,
                blockNo: BigInt(r.blockNo), blockSizeBytes: r.blockSizeBytes, blockCbor,
              } satisfies StoredBlock;
            }
            // Then immutable
            const iRows = yield* query(
              db.select().from(schema.immutableBlocks)
                .where(and(
                  eq(schema.immutableBlocks.hash, point.hash),
                  eq(schema.immutableBlocks.slot, Number(point.slot)),
                )).limit(1),
            );
            if (iRows.length === 0) return undefined;
            const r = iRows[0]!;
            const blockCbor = yield* store.get(blockKey(point.slot, point.hash));
            if (!blockCbor) return undefined;
            return {
              slot: BigInt(r.slot), hash: r.hash,
              prevHash: r.prevHash ?? undefined,
              blockNo: BigInt(r.blockNo), blockSizeBytes: r.size, blockCbor,
            } satisfies StoredBlock;
          }).pipe(Effect.mapError((c) => fail("getBlockAt", c))),

        // --- Tip ---
        getTip: Effect.gen(function* () {
          // Volatile tip first (highest slot among volatile)
          const vRows = yield* query(
            db.select({ slot: schema.volatileBlocks.slot, hash: schema.volatileBlocks.hash })
              .from(schema.volatileBlocks)
              .orderBy(desc(schema.volatileBlocks.slot))
              .limit(1),
          );
          if (vRows.length > 0) {
            return { slot: BigInt(vRows[0]!.slot), hash: vRows[0]!.hash } satisfies RealPoint;
          }
          // Then immutable tip
          const iRows = yield* query(
            db.select({ slot: schema.immutableBlocks.slot, hash: schema.immutableBlocks.hash })
              .from(schema.immutableBlocks)
              .orderBy(desc(schema.immutableBlocks.slot))
              .limit(1),
          );
          if (iRows.length === 0) return undefined;
          return { slot: BigInt(iRows[0]!.slot), hash: iRows[0]!.hash } satisfies RealPoint;
        }).pipe(Effect.mapError((c) => fail("getTip", c))),

        getImmutableTip: Effect.gen(function* () {
          const rows = yield* query(
            db.select({ slot: schema.immutableBlocks.slot, hash: schema.immutableBlocks.hash })
              .from(schema.immutableBlocks)
              .orderBy(desc(schema.immutableBlocks.slot))
              .limit(1),
          );
          if (rows.length === 0) return undefined;
          return { slot: BigInt(rows[0]!.slot), hash: rows[0]!.hash } satisfies RealPoint;
        }).pipe(Effect.mapError((c) => fail("getImmutableTip", c))),

        // --- Writing ---
        addBlock: (block: StoredBlock) =>
          Effect.gen(function* () {
            yield* store.put(blockKey(block.slot, block.hash), block.blockCbor);
            yield* query(
              db.insert(schema.volatileBlocks).values({
                hash: block.hash,
                slot: Number(block.slot),
                prevHash: block.prevHash ?? null,
                blockNo: Number(block.blockNo),
                blockSizeBytes: block.blockSizeBytes,
              }).onConflictDoNothing({ target: schema.volatileBlocks.hash }),
            );
          }).pipe(Effect.mapError((c) => fail("addBlock", c))),

        // --- Fork handling ---
        rollback: (point: RealPoint) =>
          Effect.gen(function* () {
            // Delete volatile blocks with slot > point.slot
            const toDelete = yield* query(
              db.select({ slot: schema.volatileBlocks.slot, hash: schema.volatileBlocks.hash })
                .from(schema.volatileBlocks)
                .where(gt(schema.volatileBlocks.slot, Number(point.slot))),
            );
            // Delete from BlobStore
            if (toDelete.length > 0) {
              yield* store.deleteBatch(
                toDelete.map((r) => blockKey(BigInt(r.slot), r.hash)),
              );
            }
            // Delete from SQL
            yield* query(
              db.delete(schema.volatileBlocks)
                .where(gt(schema.volatileBlocks.slot, Number(point.slot))),
            );
          }).pipe(Effect.mapError((c) => fail("rollback", c))),

        getSuccessors: (hash: Uint8Array) =>
          Effect.gen(function* () {
            const rows = yield* query(
              db.select({ hash: schema.volatileBlocks.hash })
                .from(schema.volatileBlocks)
                .where(eq(schema.volatileBlocks.prevHash, hash)),
            );
            return rows.map((r) => r.hash);
          }).pipe(Effect.mapError((c) => fail("getSuccessors", c))),

        // --- Iterators ---
        streamFrom: (from: RealPoint) =>
          Stream.fromEffect(
            Effect.gen(function* () {
              // Get all blocks after `from` in slot order (immutable + volatile)
              const iRows = yield* query(
                db.select().from(schema.immutableBlocks)
                  .where(gt(schema.immutableBlocks.slot, Number(from.slot)))
                  .orderBy(asc(schema.immutableBlocks.slot)),
              );
              const vRows = yield* query(
                db.select().from(schema.volatileBlocks)
                  .where(gt(schema.volatileBlocks.slot, Number(from.slot)))
                  .orderBy(asc(schema.volatileBlocks.slot)),
              );
              // Merge in slot order
              const allRows = [
                ...iRows.map((r) => ({ ...r, source: "immutable" })),
                ...vRows.map((r) => ({ ...r, source: "volatile" })),
              ].sort((a, b) => a.slot - b.slot);

              const blocks: StoredBlock[] = [];
              for (const r of allRows) {
                const blockCbor = yield* store.get(blockKey(BigInt(r.slot), r.hash));
                if (blockCbor) {
                  blocks.push({
                    slot: BigInt(r.slot), hash: r.hash,
                    prevHash: r.prevHash ?? undefined,
                    blockNo: BigInt(r.blockNo),
                    blockSizeBytes: "blockSizeBytes" in r ? (r as any).blockSizeBytes : (r as any).size ?? 0,
                    blockCbor,
                  });
                }
              }
              return blocks;
            }).pipe(Effect.mapError((c) => fail("streamFrom", c))),
          ).pipe(Stream.flatMap((blocks) => Stream.fromIterable(blocks))),

        // --- Immutable promotion ---
        promoteToImmutable: (upTo: RealPoint) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            // Move volatile blocks with slot <= upTo.slot to immutable
            const rows = yield* query(
              db.select().from(schema.volatileBlocks)
                .where(lt(schema.volatileBlocks.slot, Number(upTo.slot) + 1))
                .orderBy(asc(schema.volatileBlocks.slot)),
            );
            for (const r of rows) {
              yield* query(
                db.insert(schema.immutableBlocks).values({
                  slot: r.slot, hash: r.hash,
                  prevHash: r.prevHash, blockNo: r.blockNo,
                  epochNo: 0, size: r.blockSizeBytes,
                  time: Math.floor(Number(now) / 1000),
                  slotLeaderId: 0, protoMajor: 0, protoMinor: 0,
                }).onConflictDoUpdate({
                  target: schema.immutableBlocks.slot,
                  set: { hash: r.hash },
                }),
              );
            }
            // Remove from volatile
            yield* query(
              db.delete(schema.volatileBlocks)
                .where(lt(schema.volatileBlocks.slot, Number(upTo.slot) + 1)),
            );
          }).pipe(Effect.mapError((c) => fail("promoteToImmutable", c))),

        // --- Garbage collection ---
        garbageCollect: (belowSlot: bigint) =>
          Effect.gen(function* () {
            const toDelete = yield* query(
              db.select({ slot: schema.volatileBlocks.slot, hash: schema.volatileBlocks.hash })
                .from(schema.volatileBlocks)
                .where(lt(schema.volatileBlocks.slot, Number(belowSlot))),
            );
            // Delete BlobStore entries
            if (toDelete.length > 0) {
              yield* store.deleteBatch(
                toDelete.map((r) => blockKey(BigInt(r.slot), r.hash)),
              );
            }
            // Delete SQL rows
            yield* query(
              db.delete(schema.volatileBlocks)
                .where(lt(schema.volatileBlocks.slot, Number(belowSlot))),
            );
          }).pipe(Effect.mapError((c) => fail("garbageCollect", c))),

        // --- Ledger state ---
        writeLedgerSnapshot: (slot: bigint, hash: Uint8Array, epoch: bigint, stateBytes: Uint8Array) =>
          Effect.gen(function* () {
            yield* store.put(snapshotBlobKey(slot), stateBytes);
            yield* query(
              db.insert(schema.ledgerSnapshots).values({
                slot: Number(slot), hash, epoch: Number(epoch),
              }).onConflictDoUpdate({
                target: schema.ledgerSnapshots.slot,
                set: { hash },
              }),
            );
          }).pipe(Effect.mapError((c) => fail("writeLedgerSnapshot", c))),

        readLatestLedgerSnapshot: Effect.gen(function* () {
          const rows = yield* query(
            db.select().from(schema.ledgerSnapshots)
              .orderBy(desc(schema.ledgerSnapshots.slot))
              .limit(1),
          );
          if (rows.length === 0) return undefined;
          const r = rows[0]!;
          const stateBytes = yield* store.get(snapshotBlobKey(BigInt(r.slot)));
          if (!stateBytes) return undefined;
          return {
            point: { slot: BigInt(r.slot), hash: r.hash },
            stateBytes,
            epoch: BigInt(r.epoch),
          };
        }).pipe(Effect.mapError((c) => fail("readLatestLedgerSnapshot", c))),
      };
    }),
  );
