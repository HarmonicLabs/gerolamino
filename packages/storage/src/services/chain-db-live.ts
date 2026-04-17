/**
 * ChainDB live implementation — backed by BlobStore + SqlClient + XState machine.
 *
 * Block CBOR stored in BlobStore under `blk:` prefix.
 * Metadata (slot, hash, prevHash, blockNo) stored in SQL.
 * Ledger state bytes stored in BlobStore under `snap` prefix.
 *
 * The XState machine (chainDBMachine) orchestrates the block lifecycle:
 *   addBlock → BLOCK_ADDED → (if volatileLength > k) copying → gc → idle
 *
 * Block writes bypass the machine for performance — they go directly to
 * BlobStore + SQL. The machine manages the background lifecycle only
 * (immutability promotion, garbage collection).
 *
 * Lookups follow spec 12.1.1: try volatile first, then immutable.
 * Rollback removes volatile blocks after the rollback point.
 */
import { Clock, Config, Effect, Layer, Option, Schema, Scope, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { createActor, fromPromise } from "xstate";
import { ChainDB, ChainDBError } from "./chain-db.ts";
import {
  BlobStore,
  blockKey,
  blockIndexKey,
  cborOffsetKey,
  snapshotKey,
  analyzeBlockCbor,
} from "../blob-store";
import { chainDBMachine } from "../machines/chaindb.ts";
import { StoredBlock, RealPoint } from "../types/StoredBlock.ts";

const fail = (operation: string, cause: unknown) => new ChainDBError({ operation, cause });

// ---------------------------------------------------------------------------
// Row schemas — type-safe SQL result decoding
// ---------------------------------------------------------------------------

const VolatileBlockRow = Schema.Struct({
  hash: Schema.Uint8Array,
  slot: Schema.Number,
  prev_hash: Schema.NullOr(Schema.Uint8Array),
  block_no: Schema.Number,
  block_size_bytes: Schema.Number,
});

const ImmutableBlockRow = Schema.Struct({
  slot: Schema.Number,
  hash: Schema.Uint8Array,
  prev_hash: Schema.NullOr(Schema.Uint8Array),
  block_no: Schema.Number,
  size: Schema.Number,
});

const PointRow = Schema.Struct({
  slot: Schema.Number,
  hash: Schema.Uint8Array,
});

const SnapshotRow = Schema.Struct({
  slot: Schema.Number,
  hash: Schema.Uint8Array,
  epoch: Schema.Number,
});

const NoncesRow = Schema.Struct({
  epoch: Schema.Number,
  active: Schema.Uint8Array,
  evolving: Schema.Uint8Array,
  candidate: Schema.Uint8Array,
});

/** Default security param (k) — overridable via SECURITY_PARAM env. */
const securityParamConfig = Config.int("SECURITY_PARAM").pipe(Config.withDefault(2160));

export const ChainDBLive: Layer.Layer<ChainDB, Config.ConfigError, BlobStore | SqlClient> =
  Layer.effect(
    ChainDB,
    Effect.gen(function* () {
      const store = yield* BlobStore;
      const sql = yield* SqlClient;
      const securityParam = yield* securityParamConfig;
      const scope = yield* Effect.scope;

      // --- Helpers ---

      /** Decode a volatile or immutable row + fetch CBOR from BlobStore. */
      const readBlockFromVolatileRow = (r: typeof VolatileBlockRow.Type) =>
        Effect.gen(function* () {
          const slot = BigInt(r.slot);
          const blockCbor = yield* store.get(blockKey(slot, r.hash));
          if (Option.isNone(blockCbor)) return Option.none<StoredBlock>();
          return Option.some<StoredBlock>({
            slot,
            hash: r.hash,
            blockNo: BigInt(r.block_no),
            blockSizeBytes: r.block_size_bytes,
            blockCbor: blockCbor.value,
            ...(r.prev_hash ? { prevHash: r.prev_hash } : {}),
          });
        });

      const readBlockFromImmutableRow = (r: typeof ImmutableBlockRow.Type) =>
        Effect.gen(function* () {
          const slot = BigInt(r.slot);
          const blockCbor = yield* store.get(blockKey(slot, r.hash));
          if (Option.isNone(blockCbor)) return Option.none<StoredBlock>();
          return Option.some<StoredBlock>({
            slot,
            hash: r.hash,
            blockNo: BigInt(r.block_no),
            blockSizeBytes: r.size,
            blockCbor: blockCbor.value,
            ...(r.prev_hash ? { prevHash: r.prev_hash } : {}),
          });
        });

      /** Volatile-first lookup: try volatile query, fall back to immutable. */
      const lookupBlock = (
        volatileQuery: Effect.Effect<Option.Option<typeof VolatileBlockRow.Type>, unknown>,
        immutableQuery: Effect.Effect<Option.Option<typeof ImmutableBlockRow.Type>, unknown>,
      ) =>
        Effect.gen(function* () {
          const vRow = yield* volatileQuery;
          if (Option.isSome(vRow)) {
            const block = yield* readBlockFromVolatileRow(vRow.value);
            if (Option.isSome(block)) return block;
          }
          const iRow = yield* immutableQuery;
          if (Option.isNone(iRow)) return Option.none<StoredBlock>();
          return yield* readBlockFromImmutableRow(iRow.value);
        });

      // --- SqlSchema query builders (created once, reused) ---

      const findVolatileByHash = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array }),
        Result: VolatileBlockRow,
        execute: (req) => sql`
          SELECT hash, slot, prev_hash, block_no, block_size_bytes
          FROM volatile_blocks WHERE hash = ${req.hash} LIMIT 1
        `,
      });

      const findImmutableByHash = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array }),
        Result: ImmutableBlockRow,
        execute: (req) => sql`
          SELECT slot, hash, prev_hash, block_no, size
          FROM immutable_blocks WHERE hash = ${req.hash} LIMIT 1
        `,
      });

      const findVolatileByPoint = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array, slot: Schema.Number }),
        Result: VolatileBlockRow,
        execute: (req) => sql`
          SELECT hash, slot, prev_hash, block_no, block_size_bytes
          FROM volatile_blocks
          WHERE hash = ${req.hash} AND slot = ${req.slot} LIMIT 1
        `,
      });

      const findImmutableByPoint = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array, slot: Schema.Number }),
        Result: ImmutableBlockRow,
        execute: (req) => sql`
          SELECT slot, hash, prev_hash, block_no, size
          FROM immutable_blocks
          WHERE hash = ${req.hash} AND slot = ${req.slot} LIMIT 1
        `,
      });

      const findTipPoint = SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: PointRow,
        execute: () => sql`
          SELECT slot, hash FROM volatile_blocks ORDER BY slot DESC LIMIT 1
        `,
      });

      const findImmutableTipPoint = SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: PointRow,
        execute: () => sql`
          SELECT slot, hash FROM immutable_blocks ORDER BY slot DESC LIMIT 1
        `,
      });

      const findVolatileSuccessors = SqlSchema.findAll({
        Request: Schema.Struct({ hash: Schema.Uint8Array }),
        Result: Schema.Struct({ hash: Schema.Uint8Array }),
        execute: (req) => sql`
          SELECT hash FROM volatile_blocks WHERE prev_hash = ${req.hash}
        `,
      });

      const findLatestSnapshot = SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: SnapshotRow,
        execute: () => sql`
          SELECT slot, hash, epoch FROM ledger_snapshots ORDER BY slot DESC LIMIT 1
        `,
      });

      const findLatestNonces = SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: NoncesRow,
        execute: () => sql`
          SELECT epoch, active, evolving, candidate FROM nonces ORDER BY epoch DESC LIMIT 1
        `,
      });

      // --- XState machine with Effect-backed invoke actors ---
      // fromPromise actors bridge XState <-> Effect at the actor boundary.
      // Effect.runPromise is unavoidable here: XState actors must return Promises.
      const providedMachine = chainDBMachine.provide({
        actors: {
          promoteBlocks: fromPromise<number, { tip: RealPoint }>(({ input }) => {
            const upTo = input.tip;
            return Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const time = Math.floor(Number(now) / 1000);

              return yield* sql.withTransaction(
                Effect.gen(function* () {
                  const findToPromote = SqlSchema.findAll({
                    Request: Schema.Struct({ slot: Schema.Number }),
                    Result: VolatileBlockRow,
                    execute: (req) => sql`
                      SELECT hash, slot, prev_hash, block_no, block_size_bytes
                      FROM volatile_blocks WHERE slot <= ${req.slot} ORDER BY slot ASC
                    `,
                  });

                  const rows = yield* findToPromote({ slot: Number(upTo.slot) });
                  for (const r of rows) {
                    yield* sql`
                      INSERT INTO immutable_blocks (slot, hash, prev_hash, block_no, epoch_no, size, time, slot_leader_id, proto_major, proto_minor)
                      VALUES (${r.slot}, ${r.hash}, ${r.prev_hash}, ${r.block_no}, ${0}, ${r.block_size_bytes}, ${time}, ${0}, ${0}, ${0})
                      ON CONFLICT (slot) DO UPDATE SET hash = ${r.hash}
                    `.unprepared;
                  }
                  yield* sql`
                    DELETE FROM volatile_blocks WHERE slot <= ${Number(upTo.slot)}
                  `.unprepared;
                  return rows.length;
                }),
              );
            }).pipe(Effect.runPromise);
          }),
          collectGarbage: fromPromise<void, { belowSlot: bigint }>(({ input }) =>
            sql
              .withTransaction(
                Effect.gen(function* () {
                  const findToDelete = SqlSchema.findAll({
                    Request: Schema.Struct({ belowSlot: Schema.Number }),
                    Result: PointRow,
                    execute: (req) => sql`
                    SELECT slot, hash FROM volatile_blocks WHERE slot < ${req.belowSlot}
                  `,
                  });

                  const rows = yield* findToDelete({ belowSlot: Number(input.belowSlot) });
                  if (rows.length > 0) {
                    yield* store.deleteBatch(rows.map((r) => blockKey(BigInt(r.slot), r.hash)));
                  }
                  yield* sql`
                  DELETE FROM volatile_blocks WHERE slot < ${Number(input.belowSlot)}
                `.unprepared;
                }),
              )
              .pipe(Effect.runPromise),
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
        // --- Lookups (volatile first, spec 12.1.1) ---
        getBlock: (hash: Uint8Array) =>
          lookupBlock(findVolatileByHash({ hash }), findImmutableByHash({ hash })).pipe(
            Effect.mapError((c) => fail("getBlock", c)),
          ),

        getBlockAt: (point: RealPoint) =>
          lookupBlock(
            findVolatileByPoint({ hash: point.hash, slot: Number(point.slot) }),
            findImmutableByPoint({ hash: point.hash, slot: Number(point.slot) }),
          ).pipe(Effect.mapError((c) => fail("getBlockAt", c))),

        // --- Tip (max of volatile and immutable) ---
        getTip: Effect.gen(function* () {
          const vTip = yield* findTipPoint(undefined);
          const iTip = yield* findImmutableTipPoint(undefined);
          const toPoint = (r: typeof PointRow.Type): RealPoint => ({
            slot: BigInt(r.slot),
            hash: r.hash,
          });
          if (Option.isSome(vTip) && Option.isSome(iTip)) {
            return vTip.value.slot >= iTip.value.slot
              ? Option.some(toPoint(vTip.value))
              : Option.some(toPoint(iTip.value));
          }
          if (Option.isSome(vTip)) return Option.some(toPoint(vTip.value));
          if (Option.isSome(iTip)) return Option.some(toPoint(iTip.value));
          return Option.none<RealPoint>();
        }).pipe(Effect.mapError((c) => fail("getTip", c))),

        getImmutableTip: Effect.gen(function* () {
          const row = yield* findImmutableTipPoint(undefined);
          return Option.map(
            row,
            (r) => ({ slot: BigInt(r.slot), hash: r.hash }) satisfies RealPoint,
          );
        }).pipe(Effect.mapError((c) => fail("getImmutableTip", c))),

        // --- Writing ---
        addBlock: (block: StoredBlock) =>
          Effect.gen(function* () {
            // Build block_index entry: bidx + blockNo(8B BE) → slot(8B BE) + hash(32B)
            const idxVal = new Uint8Array(40);
            const idxView = new DataView(idxVal.buffer);
            idxView.setBigUint64(0, block.slot, false);
            idxVal.set(block.hash, 8);

            // Analyze block CBOR for tx offsets (works on full blocks; no-ops on headers)
            const analysis = analyzeBlockCbor(block.blockCbor);
            const offsetEntries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
            for (let i = 0; i < analysis.txOffsets.length; i++) {
              const o = analysis.txOffsets[i]!;
              const val = new Uint8Array(8);
              const dv = new DataView(val.buffer);
              dv.setUint32(0, o.offset, false);
              dv.setUint32(4, o.size, false);
              offsetEntries.push({ key: cborOffsetKey(block.slot, i), value: val });
            }

            yield* sql.withTransaction(
              Effect.all(
                [
                  store.put(blockKey(block.slot, block.hash), block.blockCbor),
                  store.put(blockIndexKey(block.blockNo), idxVal),
                  offsetEntries.length > 0 ? store.putBatch(offsetEntries) : Effect.void,
                  sql`
                    INSERT INTO volatile_blocks (hash, slot, prev_hash, block_no, block_size_bytes)
                    VALUES (${block.hash}, ${Number(block.slot)}, ${block.prevHash ?? null}, ${Number(block.blockNo)}, ${block.blockSizeBytes})
                    ON CONFLICT (hash) DO NOTHING
                  `.unprepared,
                ],
                { concurrency: "unbounded" },
              ),
            );

            // Notify machine — drives lifecycle (immutability promotion, GC).
            // Block write is already complete; this event updates bookkeeping only.
            actor.send({
              type: "BLOCK_ADDED",
              tip: { slot: block.slot, hash: block.hash },
            });
          }).pipe(Effect.mapError((c) => fail("addBlock", c))),

        // --- Batch blob writes (for derived entries: utxo diffs, stake, accounts) ---
        writeBlobEntries: (
          entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>,
        ) =>
          entries.length > 0
            ? store.putBatch(entries).pipe(Effect.mapError((c) => fail("writeBlobEntries", c)))
            : Effect.void,

        // --- Batch blob deletes (consumed UTxO inputs, deregistered accounts) ---
        deleteBlobEntries: (keys: ReadonlyArray<Uint8Array>) =>
          keys.length > 0
            ? store.deleteBatch(keys).pipe(Effect.mapError((c) => fail("deleteBlobEntries", c)))
            : Effect.void,

        // --- Fork handling ---
        rollback: (point: RealPoint) =>
          Effect.gen(function* () {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const findToDelete = SqlSchema.findAll({
                  Request: Schema.Struct({ slot: Schema.Number }),
                  Result: PointRow,
                  execute: (req) => sql`
                    SELECT slot, hash FROM volatile_blocks WHERE slot > ${req.slot}
                  `,
                });

                const rows = yield* findToDelete({ slot: Number(point.slot) });
                if (rows.length > 0) {
                  yield* store.deleteBatch(rows.map((r) => blockKey(BigInt(r.slot), r.hash)));
                }
                yield* sql`
                  DELETE FROM volatile_blocks WHERE slot > ${Number(point.slot)}
                `.unprepared;
              }),
            );

            actor.send({ type: "ROLLBACK", point });
          }).pipe(Effect.mapError((c) => fail("rollback", c))),

        getSuccessors: (hash: Uint8Array) =>
          Effect.gen(function* () {
            const rows = yield* findVolatileSuccessors({ hash });
            return rows.map((r) => r.hash);
          }).pipe(Effect.mapError((c) => fail("getSuccessors", c))),

        // --- Iterators ---
        streamFrom: (from: RealPoint) =>
          Stream.fromEffect(
            Effect.gen(function* () {
              const findImmutableFrom = SqlSchema.findAll({
                Request: Schema.Struct({ slot: Schema.Number }),
                Result: ImmutableBlockRow,
                execute: (req) => sql`
                  SELECT slot, hash, prev_hash, block_no, size
                  FROM immutable_blocks WHERE slot > ${req.slot} ORDER BY slot ASC
                `,
              });
              const findVolatileFrom = SqlSchema.findAll({
                Request: Schema.Struct({ slot: Schema.Number }),
                Result: VolatileBlockRow,
                execute: (req) => sql`
                  SELECT hash, slot, prev_hash, block_no, block_size_bytes
                  FROM volatile_blocks WHERE slot > ${req.slot} ORDER BY slot ASC
                `,
              });

              const slot = Number(from.slot);
              const iRows = yield* findImmutableFrom({ slot });
              const vRows = yield* findVolatileFrom({ slot });

              // Merge in slot order
              const allRows = [
                ...iRows.map((r) => ({
                  slot: r.slot,
                  hash: r.hash,
                  prev_hash: r.prev_hash,
                  block_no: r.block_no,
                  blockSizeBytes: r.size,
                })),
                ...vRows.map((r) => ({
                  slot: r.slot,
                  hash: r.hash,
                  prev_hash: r.prev_hash,
                  block_no: r.block_no,
                  blockSizeBytes: r.block_size_bytes,
                })),
              ].sort((a, b) => a.slot - b.slot);

              const blocks: StoredBlock[] = [];
              for (const r of allRows) {
                const blockCbor = yield* store.get(blockKey(BigInt(r.slot), r.hash));
                if (Option.isSome(blockCbor)) {
                  blocks.push({
                    slot: BigInt(r.slot),
                    hash: r.hash,
                    ...(r.prev_hash ? { prevHash: r.prev_hash } : {}),
                    blockNo: BigInt(r.block_no),
                    blockSizeBytes: r.blockSizeBytes,
                    blockCbor: blockCbor.value,
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
            const time = Math.floor(Number(now) / 1000);

            yield* sql.withTransaction(
              Effect.gen(function* () {
                const findToPromote = SqlSchema.findAll({
                  Request: Schema.Struct({ slot: Schema.Number }),
                  Result: VolatileBlockRow,
                  execute: (req) => sql`
                    SELECT hash, slot, prev_hash, block_no, block_size_bytes
                    FROM volatile_blocks WHERE slot <= ${req.slot} ORDER BY slot ASC
                  `,
                });

                const rows = yield* findToPromote({ slot: Number(upTo.slot) });
                for (const r of rows) {
                  yield* sql`
                    INSERT INTO immutable_blocks (slot, hash, prev_hash, block_no, epoch_no, size, time, slot_leader_id, proto_major, proto_minor)
                    VALUES (${r.slot}, ${r.hash}, ${r.prev_hash}, ${r.block_no}, ${0}, ${r.block_size_bytes}, ${time}, ${0}, ${0}, ${0})
                    ON CONFLICT (slot) DO UPDATE SET hash = ${r.hash}
                  `.unprepared;
                }
                yield* sql`
                  DELETE FROM volatile_blocks WHERE slot <= ${Number(upTo.slot)}
                `.unprepared;
              }),
            );
          }).pipe(Effect.mapError((c) => fail("promoteToImmutable", c))),

        // --- Garbage collection ---
        garbageCollect: (belowSlot: bigint) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const findToDelete = SqlSchema.findAll({
                  Request: Schema.Struct({ belowSlot: Schema.Number }),
                  Result: PointRow,
                  execute: (req) => sql`
                  SELECT slot, hash FROM volatile_blocks WHERE slot < ${req.belowSlot}
                `,
                });

                const rows = yield* findToDelete({ belowSlot: Number(belowSlot) });
                if (rows.length > 0) {
                  yield* store.deleteBatch(rows.map((r) => blockKey(BigInt(r.slot), r.hash)));
                }
                yield* sql`
                DELETE FROM volatile_blocks WHERE slot < ${Number(belowSlot)}
              `.unprepared;
              }),
            )
            .pipe(Effect.mapError((c) => fail("garbageCollect", c))),

        // --- Ledger state ---
        writeLedgerSnapshot: (
          slot: bigint,
          hash: Uint8Array,
          epoch: bigint,
          stateBytes: Uint8Array,
        ) =>
          sql
            .withTransaction(
              Effect.all(
                [
                  store.put(snapshotKey(slot), stateBytes),
                  sql`
                  INSERT INTO ledger_snapshots (slot, hash, epoch)
                  VALUES (${Number(slot)}, ${hash}, ${Number(epoch)})
                  ON CONFLICT (slot) DO UPDATE SET hash = ${hash}
                `.unprepared,
                ],
                { concurrency: "unbounded" },
              ),
            )
            .pipe(Effect.mapError((c) => fail("writeLedgerSnapshot", c))),

        readLatestLedgerSnapshot: Effect.gen(function* () {
          const row = yield* findLatestSnapshot(undefined);
          if (Option.isNone(row)) return Option.none();
          const r = row.value;
          const stateBytes = yield* store.get(snapshotKey(BigInt(r.slot)));
          if (Option.isNone(stateBytes)) return Option.none();
          return Option.some({
            point: { slot: BigInt(r.slot), hash: r.hash },
            stateBytes: stateBytes.value,
            epoch: BigInt(r.epoch),
          });
        }).pipe(Effect.mapError((c) => fail("readLatestLedgerSnapshot", c))),

        // --- Nonce persistence ---
        writeNonces: (
          epoch: bigint,
          active: Uint8Array,
          evolving: Uint8Array,
          candidate: Uint8Array,
        ) =>
          sql`
            INSERT INTO nonces (epoch, active, evolving, candidate)
            VALUES (${Number(epoch)}, ${active}, ${evolving}, ${candidate})
            ON CONFLICT (epoch) DO UPDATE SET
              active = ${active}, evolving = ${evolving}, candidate = ${candidate}
          `.unprepared.pipe(Effect.mapError((c) => fail("writeNonces", c))),

        readNonces: Effect.gen(function* () {
          const row = yield* findLatestNonces(undefined);
          if (Option.isNone(row)) return Option.none();
          const r = row.value;
          return Option.some({
            epoch: BigInt(r.epoch),
            active: r.active,
            evolving: r.evolving,
            candidate: r.candidate,
          });
        }).pipe(Effect.mapError((c) => fail("readNonces", c))),
      };
    }),
  );
