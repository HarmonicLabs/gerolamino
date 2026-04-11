/**
 * ChainDB live implementation — backed by BlobStore + SqliteDrizzle + XState machine.
 *
 * Block CBOR stored in BlobStore under `blk:` prefix.
 * Metadata (slot, hash, prevHash, blockNo) stored in SQL.
 * Ledger state bytes stored in BlobStore under `snap` prefix.
 *
 * The XState machine (chainDBMachine) orchestrates the block lifecycle:
 *   addBlock → BLOCK_RECEIVED → CHAIN_SELECTED → IMMUTABILITY_CHECK
 *   → (if volatileLength > k) copying (invoke promoteToImmutable)
 *   → gc (invoke garbageCollect) → idle
 *
 * Block writes bypass the machine for performance — they go directly to
 * BlobStore + SQL. The machine manages the background lifecycle only
 * (immutability promotion, garbage collection).
 *
 * Lookups follow spec 12.1.1: try volatile first, then immutable.
 * Rollback removes volatile blocks after the rollback point.
 */
import { Clock, Config, Effect, Layer, Option, Scope, Stream } from "effect";
import { createActor, fromPromise } from "xstate";
import { eq, and, lt, gt, desc, asc } from "drizzle-orm";
import { ChainDB, ChainDBError } from "./chain-db.ts";
import { BlobStore, blockKey, PREFIX_BLK } from "../blob-store";
import { SqliteDrizzle, query, schema } from "../db";
import { chainDBMachine } from "../machines/chaindb.ts";
import { StoredBlock, RealPoint } from "../types/StoredBlock.ts";

/** Convert Uint8Array to Buffer for Drizzle blob columns. */
const buf = (data: Uint8Array): Buffer =>
  Buffer.from(data.buffer, data.byteOffset, data.byteLength);

/** Convert Buffer from Drizzle back to plain Uint8Array for domain types. */
const u8 = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

const fail = (operation: string, cause: unknown) => new ChainDBError({ operation, cause });

/** BlobStore key for ledger snapshot state bytes. */
const snapshotBlobKey = (slot: bigint): Uint8Array => {
  const prefix = new TextEncoder().encode("snap");
  const buf = new Uint8Array(prefix.length + 8);
  buf.set(prefix);
  new DataView(buf.buffer, buf.byteOffset).setBigUint64(prefix.length, slot);
  return buf;
};

/** Default security param (k) — overridable via SECURITY_PARAM env. */
const securityParamConfig = Config.int("SECURITY_PARAM").pipe(Config.withDefault(2160));

export const ChainDBLive: Layer.Layer<ChainDB, Config.ConfigError, BlobStore | SqliteDrizzle> = Layer.effect(
  ChainDB,
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const db = yield* SqliteDrizzle;
    const securityParam = yield* securityParamConfig;
    const scope = yield* Effect.scope;

    // --- XState machine with Effect-backed invoke actors ---
    // fromPromise actors bridge XState ↔ Effect at the actor boundary.
    // Effect.runPromise is unavoidable here: XState actors must return Promises.
    const providedMachine = chainDBMachine.provide({
      actors: {
        promoteBlocks: fromPromise<number, { tip: RealPoint }>(({ input }) => {
          const upTo = input.tip;
          return Effect.runPromise(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const rows = yield* query(
                db
                  .select()
                  .from(schema.volatileBlocks)
                  .where(lt(schema.volatileBlocks.slot, Number(upTo.slot) + 1))
                  .orderBy(asc(schema.volatileBlocks.slot)),
              );
              for (const r of rows) {
                yield* query(
                  db
                    .insert(schema.immutableBlocks)
                    .values({
                      slot: r.slot,
                      hash: r.hash,
                      prevHash: r.prevHash,
                      blockNo: r.blockNo,
                      epochNo: 0,
                      size: r.blockSizeBytes,
                      time: Math.floor(Number(now) / 1000),
                      slotLeaderId: 0,
                      protoMajor: 0,
                      protoMinor: 0,
                    })
                    .onConflictDoUpdate({
                      target: schema.immutableBlocks.slot,
                      set: { hash: r.hash },
                    }),
                );
              }
              yield* query(
                db
                  .delete(schema.volatileBlocks)
                  .where(lt(schema.volatileBlocks.slot, Number(upTo.slot) + 1)),
              );
              return rows.length;
            }),
          );
        }),
        collectGarbage: fromPromise<void, { belowSlot: bigint }>(({ input }) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const toDelete = yield* query(
                db
                  .select({ slot: schema.volatileBlocks.slot, hash: schema.volatileBlocks.hash })
                  .from(schema.volatileBlocks)
                  .where(lt(schema.volatileBlocks.slot, Number(input.belowSlot))),
              );
              if (toDelete.length > 0) {
                yield* store.deleteBatch(toDelete.map((r) => blockKey(BigInt(r.slot), r.hash)));
              }
              yield* query(
                db
                  .delete(schema.volatileBlocks)
                  .where(lt(schema.volatileBlocks.slot, Number(input.belowSlot))),
              );
            }),
          ),
        ),
      },
    });

    const actor = createActor(providedMachine, { input: { securityParam } });
    actor.start();

    // Stop actor on scope finalization
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => actor.stop()),
    );

    return {
      // --- Lookups (volatile first) ---
      getBlock: (hash: Uint8Array) =>
        Effect.gen(function* () {
          const hashBuf = buf(hash);
          // Try volatile first (spec 12.1.1)
          const vRows = yield* query(
            db
              .select()
              .from(schema.volatileBlocks)
              .where(eq(schema.volatileBlocks.hash, hashBuf))
              .limit(1),
          );
          if (vRows.length > 0) {
            const r = vRows[0]!;
            const blockCbor = yield* store.get(blockKey(BigInt(r.slot), r.hash));
            if (Option.isSome(blockCbor)) {
              const block = {
                slot: BigInt(r.slot),
                hash: u8(r.hash),
                ...(r.prevHash ? { prevHash: u8(r.prevHash) } : {}),
                blockNo: BigInt(r.blockNo),
                blockSizeBytes: r.blockSizeBytes,
                blockCbor: blockCbor.value,
              };
              return Option.some<StoredBlock>(block);
            }
          }
          // Then immutable
          const iRows = yield* query(
            db
              .select()
              .from(schema.immutableBlocks)
              .where(eq(schema.immutableBlocks.hash, hashBuf))
              .limit(1),
          );
          if (iRows.length === 0) return Option.none<StoredBlock>();
          const r = iRows[0]!;
          const blockCbor = yield* store.get(blockKey(BigInt(r.slot), r.hash));
          if (Option.isNone(blockCbor)) return Option.none<StoredBlock>();
          const block = {
            slot: BigInt(r.slot),
            hash: u8(r.hash),
            ...(r.prevHash ? { prevHash: u8(r.prevHash) } : {}),
            blockNo: BigInt(r.blockNo),
            blockSizeBytes: r.size,
            blockCbor: blockCbor.value,
          };
          return Option.some<StoredBlock>(block);
        }).pipe(Effect.mapError((c) => fail("getBlock", c))),

      getBlockAt: (point: RealPoint) =>
        Effect.gen(function* () {
          const hashBuf = buf(point.hash);
          // Try volatile first
          const vRows = yield* query(
            db
              .select()
              .from(schema.volatileBlocks)
              .where(
                and(
                  eq(schema.volatileBlocks.hash, hashBuf),
                  eq(schema.volatileBlocks.slot, Number(point.slot)),
                ),
              )
              .limit(1),
          );
          if (vRows.length > 0) {
            const r = vRows[0]!;
            const blockCbor = yield* store.get(blockKey(point.slot, point.hash));
            if (Option.isSome(blockCbor)) {
              const block = {
                slot: BigInt(r.slot),
                hash: u8(r.hash),
                ...(r.prevHash ? { prevHash: u8(r.prevHash) } : {}),
                blockNo: BigInt(r.blockNo),
                blockSizeBytes: r.blockSizeBytes,
                blockCbor: blockCbor.value,
              };
              return Option.some<StoredBlock>(block);
            }
          }
          // Then immutable
          const iRows = yield* query(
            db
              .select()
              .from(schema.immutableBlocks)
              .where(
                and(
                  eq(schema.immutableBlocks.hash, hashBuf),
                  eq(schema.immutableBlocks.slot, Number(point.slot)),
                ),
              )
              .limit(1),
          );
          if (iRows.length === 0) return Option.none<StoredBlock>();
          const r = iRows[0]!;
          const blockCbor = yield* store.get(blockKey(point.slot, point.hash));
          if (Option.isNone(blockCbor)) return Option.none<StoredBlock>();
          const block = {
            slot: BigInt(r.slot),
            hash: u8(r.hash),
            ...(r.prevHash ? { prevHash: u8(r.prevHash) } : {}),
            blockNo: BigInt(r.blockNo),
            blockSizeBytes: r.size,
            blockCbor: blockCbor.value,
          };
          return Option.some<StoredBlock>(block);
        }).pipe(Effect.mapError((c) => fail("getBlockAt", c))),

      // --- Tip ---
      getTip: Effect.gen(function* () {
        // Volatile tip first (highest slot among volatile)
        const vRows = yield* query(
          db
            .select({ slot: schema.volatileBlocks.slot, hash: schema.volatileBlocks.hash })
            .from(schema.volatileBlocks)
            .orderBy(desc(schema.volatileBlocks.slot))
            .limit(1),
        );
        if (vRows.length > 0) {
          const point = { slot: BigInt(vRows[0]!.slot), hash: u8(vRows[0]!.hash) };
          return Option.some<RealPoint>(point);
        }
        // Then immutable tip
        const iRows = yield* query(
          db
            .select({ slot: schema.immutableBlocks.slot, hash: schema.immutableBlocks.hash })
            .from(schema.immutableBlocks)
            .orderBy(desc(schema.immutableBlocks.slot))
            .limit(1),
        );
        if (iRows.length === 0) return Option.none<RealPoint>();
        const point = { slot: BigInt(iRows[0]!.slot), hash: u8(iRows[0]!.hash) };
        return Option.some<RealPoint>(point);
      }).pipe(Effect.mapError((c) => fail("getTip", c))),

      getImmutableTip: Effect.gen(function* () {
        const rows = yield* query(
          db
            .select({ slot: schema.immutableBlocks.slot, hash: schema.immutableBlocks.hash })
            .from(schema.immutableBlocks)
            .orderBy(desc(schema.immutableBlocks.slot))
            .limit(1),
        );
        if (rows.length === 0) return Option.none<RealPoint>();
        const point = { slot: BigInt(rows[0]!.slot), hash: u8(rows[0]!.hash) };
        return Option.some<RealPoint>(point);
      }).pipe(Effect.mapError((c) => fail("getImmutableTip", c))),

      // --- Writing ---
      addBlock: (block: StoredBlock) =>
        Effect.gen(function* () {
          yield* store.put(blockKey(block.slot, block.hash), block.blockCbor);
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

          // Notify machine — drives lifecycle (immutability promotion, GC).
          // Block write is already complete; these events update bookkeeping only.
          const tip = { slot: block.slot, hash: block.hash };
          actor.send({ type: "BLOCK_RECEIVED" });
          actor.send({ type: "CHAIN_SELECTED", tip });
          actor.send({ type: "IMMUTABILITY_CHECK" });
        }).pipe(Effect.mapError((c) => fail("addBlock", c))),

      // --- Fork handling ---
      rollback: (point: RealPoint) =>
        Effect.gen(function* () {
          // Delete volatile blocks with slot > point.slot
          const toDelete = yield* query(
            db
              .select({ slot: schema.volatileBlocks.slot, hash: schema.volatileBlocks.hash })
              .from(schema.volatileBlocks)
              .where(gt(schema.volatileBlocks.slot, Number(point.slot))),
          );
          // Delete from BlobStore
          if (toDelete.length > 0) {
            yield* store.deleteBatch(toDelete.map((r) => blockKey(BigInt(r.slot), r.hash)));
          }
          // Delete from SQL
          yield* query(
            db
              .delete(schema.volatileBlocks)
              .where(gt(schema.volatileBlocks.slot, Number(point.slot))),
          );

          // Notify machine of rollback
          actor.send({ type: "ROLLBACK", point });
        }).pipe(Effect.mapError((c) => fail("rollback", c))),

      getSuccessors: (hash: Uint8Array) =>
        Effect.gen(function* () {
          const rows = yield* query(
            db
              .select({ hash: schema.volatileBlocks.hash })
              .from(schema.volatileBlocks)
              .where(eq(schema.volatileBlocks.prevHash, buf(hash))),
          );
          return rows.map((r) => r.hash);
        }).pipe(Effect.mapError((c) => fail("getSuccessors", c))),

      // --- Iterators ---
      streamFrom: (from: RealPoint) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            // Get all blocks after `from` in slot order (immutable + volatile)
            const iRows = yield* query(
              db
                .select()
                .from(schema.immutableBlocks)
                .where(gt(schema.immutableBlocks.slot, Number(from.slot)))
                .orderBy(asc(schema.immutableBlocks.slot)),
            );
            const vRows = yield* query(
              db
                .select()
                .from(schema.volatileBlocks)
                .where(gt(schema.volatileBlocks.slot, Number(from.slot)))
                .orderBy(asc(schema.volatileBlocks.slot)),
            );
            // Merge in slot order
            const allRows = [
              ...iRows.map((r) => ({ ...r, source: "immutable" as const })),
              ...vRows.map((r) => ({ ...r, source: "volatile" as const })),
            ].sort((a, b) => a.slot - b.slot);

            const blocks: StoredBlock[] = [];
            for (const r of allRows) {
              const blockCbor = yield* store.get(blockKey(BigInt(r.slot), r.hash));
              if (Option.isSome(blockCbor)) {
                const blockSizeBytes = r.source === "volatile" ? r.blockSizeBytes : r.size;
                const block: StoredBlock = {
                  slot: BigInt(r.slot),
                  hash: u8(r.hash),
                  ...(r.prevHash ? { prevHash: u8(r.prevHash) } : {}),
                  blockNo: BigInt(r.blockNo),
                  blockSizeBytes,
                  blockCbor: blockCbor.value,
                };
                blocks.push(block);
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
            db
              .select()
              .from(schema.volatileBlocks)
              .where(lt(schema.volatileBlocks.slot, Number(upTo.slot) + 1))
              .orderBy(asc(schema.volatileBlocks.slot)),
          );
          for (const r of rows) {
            yield* query(
              db
                .insert(schema.immutableBlocks)
                .values({
                  slot: r.slot,
                  hash: r.hash,
                  prevHash: r.prevHash,
                  blockNo: r.blockNo,
                  epochNo: 0,
                  size: r.blockSizeBytes,
                  time: Math.floor(Number(now) / 1000),
                  slotLeaderId: 0,
                  protoMajor: 0,
                  protoMinor: 0,
                })
                .onConflictDoUpdate({
                  target: schema.immutableBlocks.slot,
                  set: { hash: r.hash },
                }),
            );
          }
          // Remove from volatile
          yield* query(
            db
              .delete(schema.volatileBlocks)
              .where(lt(schema.volatileBlocks.slot, Number(upTo.slot) + 1)),
          );
        }).pipe(Effect.mapError((c) => fail("promoteToImmutable", c))),

      // --- Garbage collection ---
      garbageCollect: (belowSlot: bigint) =>
        Effect.gen(function* () {
          const toDelete = yield* query(
            db
              .select({ slot: schema.volatileBlocks.slot, hash: schema.volatileBlocks.hash })
              .from(schema.volatileBlocks)
              .where(lt(schema.volatileBlocks.slot, Number(belowSlot))),
          );
          // Delete BlobStore entries
          if (toDelete.length > 0) {
            yield* store.deleteBatch(toDelete.map((r) => blockKey(BigInt(r.slot), r.hash)));
          }
          // Delete SQL rows
          yield* query(
            db
              .delete(schema.volatileBlocks)
              .where(lt(schema.volatileBlocks.slot, Number(belowSlot))),
          );
        }).pipe(Effect.mapError((c) => fail("garbageCollect", c))),

      // --- Ledger state ---
      writeLedgerSnapshot: (
        slot: bigint,
        hash: Uint8Array,
        epoch: bigint,
        stateBytes: Uint8Array,
      ) =>
        Effect.gen(function* () {
          yield* store.put(snapshotBlobKey(slot), stateBytes);
          const hashBuf = buf(hash);
          yield* query(
            db
              .insert(schema.ledgerSnapshots)
              .values({
                slot: Number(slot),
                hash: hashBuf,
                epoch: Number(epoch),
              })
              .onConflictDoUpdate({
                target: schema.ledgerSnapshots.slot,
                set: { hash: hashBuf },
              }),
          );
        }).pipe(Effect.mapError((c) => fail("writeLedgerSnapshot", c))),

      readLatestLedgerSnapshot: Effect.gen(function* () {
        const rows = yield* query(
          db
            .select()
            .from(schema.ledgerSnapshots)
            .orderBy(desc(schema.ledgerSnapshots.slot))
            .limit(1),
        );
        if (rows.length === 0) return Option.none();
        const r = rows[0]!;
        const stateBytes = yield* store.get(snapshotBlobKey(BigInt(r.slot)));
        if (Option.isNone(stateBytes)) return Option.none();
        return Option.some({
          point: { slot: BigInt(r.slot), hash: u8(r.hash) },
          stateBytes: stateBytes.value,
          epoch: BigInt(r.epoch),
        });
      }).pipe(Effect.mapError((c) => fail("readLatestLedgerSnapshot", c))),
    };
  }),
);
