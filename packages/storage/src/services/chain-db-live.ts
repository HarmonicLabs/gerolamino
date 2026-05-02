/**
 * ChainDB live implementation — backed by BlobStore + SqlClient + a pure
 * Effect-native lifecycle reducer.
 *
 * Block CBOR stored in BlobStore under `blk:` prefix.
 * Metadata (slot, hash, prevHash, blockNo) stored in SQL.
 * Ledger state bytes stored in BlobStore under `snap` prefix.
 *
 * Lifecycle orchestration (previously an XState parallel-region machine)
 * is now three scoped fibers hung off `Layer.effect`:
 *
 *   1. **dispatchFiber** drains `Queue<ChainDBEvent>` and folds each event
 *      into `SubscriptionRef<ChainDBState>` via the pure `reduce`
 *      function from `../machines/chaindb.ts`.
 *
 *   2. **driverFiber** watches `state.changes` for immutability-region
 *      transitions (`idle → copying → gc → idle`) and dispatches the
 *      corresponding side effects (SQL `promoteBlocksEffect` or
 *      `collectGarbageEffect`). The completion feedback loops back by
 *      offering `PromoteDone` / `PromoteFailed` / `GcDone` / `GcFailed`
 *      onto the same event queue — a closed-loop reactor, no XState,
 *      no `*Unsafe` ops, no dual-world teardown.
 *
 *   3. `Effect.forkScoped` ties both fibers to the layer's scope so
 *      `Layer.launch` shutdown interrupts them cleanly.
 *
 * Block writes bypass the lifecycle for performance — they go directly
 * to BlobStore + SQL, then enqueue a `BlockAdded` event so bookkeeping
 * catches up and the immutability region advances if the volatile window
 * has grown past `k`.
 *
 * Lookups follow spec 12.1.1: try volatile first, then immutable.
 * Rollback removes volatile blocks after the rollback point and
 * enqueues a `Rollback` event so the state cursor tracks the tip move.
 */
import {
  type Cause,
  Config,
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { and, asc, count, desc, eq, gt, lt, lte, sql as sqlExpr } from "drizzle-orm";
import { ChainDB, ChainDBError, type ChainDBOperation } from "./chain-db.ts";
import {
  type BlobEntry,
  BlobStore,
  blockKey,
  blockIndexKey,
  cborOffsetKey,
  analyzeBlockCbor,
  type BlockAnalysis,
} from "../blob-store";
import {
  BlockRow,
  IMMUTABLE_BLOCK_DEFAULTS,
  timeUnixSeconds,
  toStoredBlock,
} from "../operations/blocks.ts";
import { ChainDBEvent, type ChainDBState, initialChainDBState, reduce } from "../machines";
import { StoredBlock, RealPoint } from "../types/StoredBlock.ts";
import { immutableBlocks, volatileBlocks } from "../schema/index.ts";
import { compile, db } from "./drizzle.ts";

// `immutable_blocks.size` and `volatile_blocks.block_size_bytes` are the
// same logical column with different SQL names; every immutable SELECT
// aliases via `sqlExpr<number>\`${immutableBlocks.size}\`.as(...)` so the
// decoded `BlockRow` shape matches across both halves and `toStoredBlock`
// stays single-source-of-truth. Defining the aliased SQL fragment once
// keeps the alias name in sync with `BlockRow.block_size_bytes`.
const immutableBlockSizeAsBlockSizeBytes = sqlExpr<number>`${immutableBlocks.size}`.as(
  "block_size_bytes",
);

/** Tag an effect's failures as a `ChainDBError` with the given operation name.
 * `operation` is typed to the `ChainDBOperation` union so typos fail at
 * compile time (the error class's Schema would accept anything at runtime
 * but TS narrows the input). */
const withOp =
  (operation: ChainDBOperation) =>
  <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, ChainDBError, R> =>
    Effect.mapError(effect, (cause) => new ChainDBError({ operation, cause }));

// ---------------------------------------------------------------------------
// Row schemas — type-safe SQL result decoding. `BlockRow` is shared with
// `operations/blocks.ts` (same alias convention: `immutable_blocks.size AS
// block_size_bytes` across every SELECT) so the two call sites can't drift.
// ---------------------------------------------------------------------------

const PointRow = Schema.Struct({
  slot: Schema.Number,
  hash: Schema.Uint8Array,
});

/** Lift a decoded `PointRow` into the bigint-slot `RealPoint` shape. */
const toPoint = (r: typeof PointRow.Type): RealPoint => ({
  slot: BigInt(r.slot),
  hash: r.hash,
});

/** Default security param (k) — overridable via SECURITY_PARAM env. */
const securityParamConfig = Config.number("SECURITY_PARAM").pipe(Config.withDefault(2160));

/** Upper-bound on `cborOffsetKey(slot, txIdx)` indices to clear when
 *  rolling back a volatile block. Set well above the practical Conway
 *  per-block tx count (median ~50, p99 ~150 on mainnet/preprod) so
 *  rollback cleanup catches every offset key without a per-block lookup
 *  query. BlobStore deletes for missing keys are no-ops, so over-deleting
 *  is cheap; under-deleting would leave orphaned offset entries. */
const ROLLBACK_TX_OFFSET_CLEANUP_RANGE = 1024;

// ---------------------------------------------------------------------------
// Blob-value encoders — byte layouts paired with their `*Key` constructors
// in `ffi/keys`. Hoisted so `addBlock`'s byte-assembly reads declaratively.
// ---------------------------------------------------------------------------

/** `block_index` entry value: 40 bytes = `slot(8B BE) + hash(32B)`. Paired
 *  with `blockIndexKey(blockNo)` so a blockNo → (slot, hash) lookup resolves
 *  the block in `blk:` storage without re-querying SQL. */
const encodeBlockIndexValue = (slot: bigint, hash: Uint8Array): Uint8Array => {
  const buf = new Uint8Array(40);
  new DataView(buf.buffer).setBigUint64(0, slot, false);
  buf.set(hash, 8);
  return buf;
};

/** `cbor_offset` entry value: 8 bytes = `offset(u32 BE) + size(u32 BE)`.
 *  Paired with `cborOffsetKey(slot, txIdx)`. */
const encodeCborOffsetValue = (offset: number, size: number): Uint8Array => {
  const buf = new Uint8Array(8);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, offset, false);
  dv.setUint32(4, size, false);
  return buf;
};

export const ChainDBLive: Layer.Layer<ChainDB, Config.ConfigError, BlobStore | SqlClient> =
  Layer.effect(
    ChainDB,
    Effect.gen(function* () {
      const store = yield* BlobStore;
      const sql = yield* SqlClient;
      const securityParam = yield* securityParamConfig;

      // --- Helpers ---

      /** Fetch the block CBOR for a decoded row; zip with row metadata to
       *  produce `Option<StoredBlock>`. Returns `None` when the SQL row
       *  exists but the BlobStore has no blob (stale index / GC race).
       *  `toStoredBlock` is shared with `operations/blocks.ts` so the
       *  row→domain mapping is the single-source-of-truth. */
      const readBlockFromRow = (r: typeof BlockRow.Type) =>
        Effect.map(
          store.get(blockKey(BigInt(r.slot), r.hash)),
          Option.map((blockCbor) => toStoredBlock(r, blockCbor)),
        );

      /** Volatile-first lookup: try volatile query, fall back to immutable.
       *  Falls through to immutable when either (a) the SQL row is absent
       *  or (b) the row is present but the BlobStore doesn't have the CBOR. */
      const lookupBlock = (
        volatileQuery: Effect.Effect<Option.Option<typeof BlockRow.Type>, unknown>,
        immutableQuery: Effect.Effect<Option.Option<typeof BlockRow.Type>, unknown>,
      ) =>
        Effect.gen(function* () {
          const vRow = yield* volatileQuery;
          if (Option.isSome(vRow)) {
            const block = yield* readBlockFromRow(vRow.value);
            if (Option.isSome(block)) return block;
          }
          const iRow = yield* immutableQuery;
          return Option.isNone(iRow)
            ? Option.none<StoredBlock>()
            : yield* readBlockFromRow(iRow.value);
        });

      // --- SqlSchema query builders (created once, reused) ---

      // BlockRow column-set helpers — built once so each query reuses
      // the identical projection. The volatile flavour uses native
      // column names; the immutable flavour aliases `size →
      // block_size_bytes` via the shared `sqlExpr` fragment defined
      // above.
      const volatileBlockColumns = {
        hash: volatileBlocks.hash,
        slot: volatileBlocks.slot,
        prev_hash: volatileBlocks.prevHash,
        block_no: volatileBlocks.blockNo,
        block_size_bytes: volatileBlocks.blockSizeBytes,
      };
      const immutableBlockColumns = {
        slot: immutableBlocks.slot,
        hash: immutableBlocks.hash,
        prev_hash: immutableBlocks.prevHash,
        block_no: immutableBlocks.blockNo,
        block_size_bytes: immutableBlockSizeAsBlockSizeBytes,
      };

      const findVolatileByHash = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array }),
        Result: BlockRow,
        execute: (req) =>
          compile(
            sql,
            db
              .select(volatileBlockColumns)
              .from(volatileBlocks)
              .where(eq(volatileBlocks.hash, req.hash))
              .limit(1),
          ),
      });

      const findImmutableByHash = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array }),
        Result: BlockRow,
        execute: (req) =>
          compile(
            sql,
            db
              .select(immutableBlockColumns)
              .from(immutableBlocks)
              .where(eq(immutableBlocks.hash, req.hash))
              .limit(1),
          ),
      });

      const findVolatileByPoint = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array, slot: Schema.Number }),
        Result: BlockRow,
        execute: (req) =>
          compile(
            sql,
            db
              .select(volatileBlockColumns)
              .from(volatileBlocks)
              .where(and(eq(volatileBlocks.hash, req.hash), eq(volatileBlocks.slot, req.slot)))
              .limit(1),
          ),
      });

      const findImmutableByPoint = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array, slot: Schema.Number }),
        Result: BlockRow,
        execute: (req) =>
          compile(
            sql,
            db
              .select(immutableBlockColumns)
              .from(immutableBlocks)
              .where(and(eq(immutableBlocks.hash, req.hash), eq(immutableBlocks.slot, req.slot)))
              .limit(1),
          ),
      });

      const findTipPoint = SqlSchema.findOneOption({
        Request: Schema.Void,
        Result: PointRow,
        execute: () =>
          compile(
            sql,
            db
              .select({ slot: volatileBlocks.slot, hash: volatileBlocks.hash })
              .from(volatileBlocks)
              .orderBy(desc(volatileBlocks.slot))
              .limit(1),
          ),
      });

      const findImmutableTipPoint = SqlSchema.findOneOption({
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

      const findVolatileSuccessors = SqlSchema.findAll({
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

      const findVolatileBelowSlot = SqlSchema.findAll({
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

      const findVolatileAboveSlot = SqlSchema.findAll({
        Request: Schema.Struct({ slot: Schema.Number }),
        Result: PointRow,
        execute: (req) =>
          compile(
            sql,
            db
              .select({ slot: volatileBlocks.slot, hash: volatileBlocks.hash })
              .from(volatileBlocks)
              .where(gt(volatileBlocks.slot, req.slot)),
          ),
      });

      const findImmutableFrom = SqlSchema.findAll({
        Request: Schema.Struct({ slot: Schema.Number }),
        Result: BlockRow,
        execute: (req) =>
          compile(
            sql,
            db
              .select(immutableBlockColumns)
              .from(immutableBlocks)
              .where(gt(immutableBlocks.slot, req.slot))
              .orderBy(asc(immutableBlocks.slot)),
          ),
      });

      const findVolatileFrom = SqlSchema.findAll({
        Request: Schema.Struct({ slot: Schema.Number }),
        Result: BlockRow,
        execute: (req) =>
          compile(
            sql,
            db
              .select(volatileBlockColumns)
              .from(volatileBlocks)
              .where(gt(volatileBlocks.slot, req.slot))
              .orderBy(asc(volatileBlocks.slot)),
          ),
      });

      const findToPromote = SqlSchema.findAll({
        Request: Schema.Struct({ slot: Schema.Number }),
        Result: BlockRow,
        execute: (req) =>
          compile(
            sql,
            db
              .select(volatileBlockColumns)
              .from(volatileBlocks)
              .where(lte(volatileBlocks.slot, req.slot))
              .orderBy(asc(volatileBlocks.slot)),
          ),
      });

      const promoteBlocksEffect = (tip: RealPoint) =>
        Effect.gen(function* () {
          const time = yield* timeUnixSeconds;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* findToPromote({ slot: Number(tip.slot) });
              if (rows.length > 0) {
                // Single multi-VALUES insert via Drizzle's bulk-insert
                // builder + SQLite `ON CONFLICT(slot) DO NOTHING`.
                //
                // `DO NOTHING` mirrors Haskell `ImmutableDB`'s append-only
                // contract: once a slot is finalized, its (slot, hash)
                // pair is immutable. The earlier `DO UPDATE SET hash =
                // excluded.hash` would silently overwrite a finalized
                // (slot, hash) with a different fork's hash if a stray
                // promotion attempt arrived later — a soundness bug
                // dressed up as idempotency. With `DO NOTHING`, a
                // re-run of `promoteBlocksEffect` on already-promoted
                // rows is a no-op for matching keys and a silent skip
                // for divergent ones; the volatile DELETE below then
                // clears the stale row regardless.
                yield* compile(
                  sql,
                  db
                    .insert(immutableBlocks)
                    .values(
                      rows.map((r) => ({
                        slot: r.slot,
                        hash: r.hash,
                        prevHash: r.prev_hash,
                        blockNo: r.block_no,
                        size: r.block_size_bytes,
                        time,
                        ...IMMUTABLE_BLOCK_DEFAULTS,
                      })),
                    )
                    .onConflictDoNothing({ target: immutableBlocks.slot }),
                );
              }
              yield* compile(
                sql,
                db.delete(volatileBlocks).where(lte(volatileBlocks.slot, Number(tip.slot))),
              );
              return rows.length;
            }),
          );
        });

      const collectGarbageEffect = (belowSlot: bigint) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* findVolatileBelowSlot({ belowSlot: Number(belowSlot) });
            if (rows.length > 0) {
              yield* store.deleteBatch(rows.map((r) => blockKey(BigInt(r.slot), r.hash)));
            }
            yield* compile(
              sql,
              db.delete(volatileBlocks).where(lt(volatileBlocks.slot, Number(belowSlot))),
            );
          }),
        );

      // --- Lifecycle reactor (SubscriptionRef + Queue + Stream) ---

      /** Observable state — consumers can also subscribe via `.changes` if
       * a future dashboard wants live immutability-region telemetry. */
      const state = yield* SubscriptionRef.make<ChainDBState>(initialChainDBState(securityParam));

      /** Event mailbox — bounded at 64 per the previous XState actor buffer. */
      const events = yield* Queue.bounded<ChainDBEvent>(64);

      /**
       * Boot seed — SQL is authoritative for block data; on restart the
       * reducer's in-memory `volatileLength` + `tip` would otherwise start
       * at zero until the next `BlockAdded` flows in. Reading from SQL
       * once at layer startup catches the "crashed mid-sync with volatile
       * window past k" case so the immutability region resumes promotion
       * without waiting for new inbound blocks.
       *
       * Runs BEFORE the dispatch + driver fibers fork so there's no race
       * between this seed and an incoming `BlockAdded`.
       */
      const findVolatileCount = SqlSchema.findOne({
        Request: Schema.Void,
        Result: Schema.Struct({ n: Schema.Number }),
        execute: () => compile(sql, db.select({ n: count().as("n") }).from(volatileBlocks)),
      });
      // `SubscriptionRef.updateEffect` runs the updater under the ref's
      // semaphore → the three SQL queries + the state mutation are one
      // atomic transition, no separate "fetch then update" phase that
      // could in theory interleave (not currently possible — the dispatch
      // fiber is forked AFTER this — but the shape is cleaner regardless).
      yield* SubscriptionRef.updateEffect(state, (s) =>
        Effect.all(
          [findVolatileCount(undefined), findTipPoint(undefined), findImmutableTipPoint(undefined)],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(
            ([vCountRow, vTip, iTip]): ChainDBState => ({
              ...s,
              volatileLength: vCountRow.n,
              tip: Option.getOrUndefined(Option.map(vTip, toPoint)),
              immutableTip: Option.getOrUndefined(Option.map(iTip, toPoint)),
              immutability: vCountRow.n > s.securityParam ? "copying" : "idle",
            }),
          ),
        ),
      ).pipe(
        // Seed is a "nice to have" — if the tables don't exist yet
        // (tests that skip migrations) or the query fails for any other
        // reason, fall back to the default in-memory zero state. The
        // reducer self-heals on the next `BlockAdded` regardless.
        Effect.catchCause((cause) =>
          Effect.logDebug("chain-db boot seed skipped").pipe(
            Effect.annotateLogs({ cause: String(cause) }),
          ),
        ),
      );

      /** dispatchFiber: drain events → reduce → publish new state. */
      yield* Effect.forkScoped(
        Stream.fromQueue(events).pipe(
          Stream.runForEach((event) => SubscriptionRef.update(state, (s) => reduce(s, event))),
        ),
      );

      /** Close the driver loop: run a side-effectful job, then offer either
       *  a success or a failure event back into the queue so the reducer
       *  steps `copying → gc → idle`. Shared between promote + gc arms. */
      const dispatchResult = <A, E>(
        effect: Effect.Effect<A, E>,
        onSuccess: (a: A) => ChainDBEvent,
        onFailure: (cause: Cause.Cause<E>) => ChainDBEvent,
      ) =>
        effect.pipe(
          Effect.matchCauseEffect({
            onSuccess: (a) => Queue.offer(events, onSuccess(a)),
            onFailure: (cause) => Queue.offer(events, onFailure(cause)),
          }),
        );

      /** driverFiber: watch immutability-region transitions; fire the
       * side-effectful work and feed completion events back into the
       * same queue. `Stream.changesWith` keys on the region alone so
       * unrelated state updates (tip changes, volatileLength bumps) do
       * NOT re-trigger the driver. */
      yield* Effect.forkScoped(
        SubscriptionRef.changes(state).pipe(
          Stream.changesWith((a, b) => a.immutability === b.immutability),
          Stream.runForEach((s) => {
            if (s.immutability === "copying" && s.tip !== undefined) {
              return dispatchResult(
                promoteBlocksEffect(s.tip),
                (promoted) => ChainDBEvent.cases.PromoteDone.make({ promoted }),
                (error) => ChainDBEvent.cases.PromoteFailed.make({ error }),
              );
            }
            if (s.immutability === "gc") {
              return dispatchResult(
                collectGarbageEffect(s.immutableTip?.slot ?? 0n),
                () => ChainDBEvent.cases.GcDone.make({}),
                (error) => ChainDBEvent.cases.GcFailed.make({ error }),
              );
            }
            return Effect.void;
          }),
        ),
      );

      return {
        // --- Lookups (volatile first, spec 12.1.1) ---
        getBlock: (hash: Uint8Array) =>
          lookupBlock(findVolatileByHash({ hash }), findImmutableByHash({ hash })).pipe(
            withOp("getBlock"),
          ),

        getBlockAt: (point: RealPoint) =>
          lookupBlock(
            findVolatileByPoint({ hash: point.hash, slot: Number(point.slot) }),
            findImmutableByPoint({ hash: point.hash, slot: Number(point.slot) }),
          ).pipe(withOp("getBlockAt")),

        // --- Tip (max-slot across volatile + immutable) ---
        getTip: Effect.all([findTipPoint(undefined), findImmutableTipPoint(undefined)], {
          concurrency: "unbounded",
        }).pipe(
          // `Option.firstSomeOf([max(v,i), v, i])` picks the max when both
          // are Some (first), otherwise whichever single value is Some —
          // one chain expresses both the merge and the fallbacks.
          Effect.map(([vTip, iTip]) =>
            Option.map(
              Option.firstSomeOf([
                Option.zipWith(vTip, iTip, (v, i) => (v.slot >= i.slot ? v : i)),
                vTip,
                iTip,
              ]),
              toPoint,
            ),
          ),
          withOp("getTip"),
        ),

        getImmutableTip: findImmutableTipPoint(undefined).pipe(
          Effect.map(Option.map(toPoint)),
          withOp("getImmutableTip"),
        ),

        // --- Writing ---
        addBlock: (block: StoredBlock) =>
          Effect.gen(function* () {
            // Analyze block CBOR for tx offsets (works on full blocks; no-ops on headers).
            // Malformed blocks surface as `BlockAnalysisParseError`; swallow to empty here
            // — the callers' upstream path (consensus validation) rejects invalid blocks
            // before they ever reach `PROMOTE`, so a parse failure at this layer means a
            // synthetic / legacy block that we still want to index without offsets.
            const analysis = yield* analyzeBlockCbor(block.blockCbor).pipe(
              Effect.orElseSucceed((): BlockAnalysis => ({ blockNo: 0n, txOffsets: [] })),
            );
            const offsetEntries: ReadonlyArray<BlobEntry> = analysis.txOffsets.map((o, i) => ({
              key: cborOffsetKey(block.slot, i),
              value: encodeCborOffsetValue(o.offset, o.size),
            }));

            yield* sql.withTransaction(
              Effect.all(
                [
                  store.put(blockKey(block.slot, block.hash), block.blockCbor),
                  store.put(
                    blockIndexKey(block.blockNo),
                    encodeBlockIndexValue(block.slot, block.hash),
                  ),
                  offsetEntries.length > 0 ? store.putBatch(offsetEntries) : Effect.void,
                  compile(
                    sql,
                    db
                      .insert(volatileBlocks)
                      .values({
                        hash: block.hash,
                        slot: Number(block.slot),
                        prevHash: block.prevHash ?? null,
                        blockNo: Number(block.blockNo),
                        blockSizeBytes: block.blockSizeBytes,
                      })
                      .onConflictDoNothing({ target: volatileBlocks.hash }),
                  ),
                ],
                { concurrency: "unbounded" },
              ),
            );

            // Notify the lifecycle reactor — drives the immutability
            // region (promotion + GC). Block write is already complete;
            // this event updates bookkeeping only.
            yield* Queue.offer(
              events,
              ChainDBEvent.cases.BlockAdded.make({
                tip: { slot: block.slot, hash: block.hash },
              }),
            );
          }).pipe(withOp("addBlock")),

        // --- Batch blob writes (for derived entries: utxo diffs, stake, accounts) ---
        writeBlobEntries: (entries: ReadonlyArray<BlobEntry>) =>
          entries.length > 0
            ? store.putBatch(entries).pipe(withOp("writeBlobEntries"))
            : Effect.void,

        // --- Batch blob deletes (consumed UTxO inputs, deregistered accounts) ---
        deleteBlobEntries: (keys: ReadonlyArray<Uint8Array>) =>
          keys.length > 0 ? store.deleteBatch(keys).pipe(withOp("deleteBlobEntries")) : Effect.void,

        // --- Fork handling ---
        rollback: (point: RealPoint) =>
          Effect.gen(function* () {
            // Delete every BlobStore entry tied to the rolled-back
            // volatile blocks, then return the count so the reducer can
            // decrement `volatileLength`. `cborOffsetKey(slot, txIdx)`
            // entries are written by `applyBlock` per-tx in the relay
            // path (`sync/relay.ts:217-219`); without explicit cleanup
            // they survive the rollback as orphaned BlobStore keys that
            // future `getTxByOffset` lookups would dereference to stale
            // bytes. We don't know the tx count per block here, so we
            // walk a small range of `cborOffsetKey(slot, i)` for
            // `i = 0..MAX_TXS_PER_BLOCK_FOR_CLEANUP`; trailing keys
            // either don't exist (BlobStore.delete is a no-op for
            // missing keys) or are stale already.
            const droppedCount = yield* sql.withTransaction(
              Effect.gen(function* () {
                const rows = yield* findVolatileAboveSlot({ slot: Number(point.slot) });
                if (rows.length > 0) {
                  const blockKeys = rows.map((r) => blockKey(BigInt(r.slot), r.hash));
                  // Generate offset cleanup keys: `cborOffsetKey(slot, i)`
                  // for every `i` in `[0, ROLLBACK_TX_OFFSET_CLEANUP_RANGE)`.
                  // The range is intentionally generous (most blocks have
                  // far fewer txs); the BlobStore delete for non-existent
                  // keys is a constant-time no-op so the over-deletion is
                  // cheap.
                  const offsetKeys = rows.flatMap((r) =>
                    Array.from({ length: ROLLBACK_TX_OFFSET_CLEANUP_RANGE }, (_, i) =>
                      cborOffsetKey(BigInt(r.slot), i),
                    ),
                  );
                  yield* store.deleteBatch([...blockKeys, ...offsetKeys]);
                }
                yield* compile(
                  sql,
                  db.delete(volatileBlocks).where(gt(volatileBlocks.slot, Number(point.slot))),
                );
                return rows.length;
              }),
            );

            yield* Queue.offer(
              events,
              ChainDBEvent.cases.Rollback.make({ point, dropped: droppedCount }),
            );
          }).pipe(withOp("rollback")),

        getSuccessors: (hash: Uint8Array) =>
          Effect.gen(function* () {
            const rows = yield* findVolatileSuccessors({ hash });
            return rows.map((r) => r.hash);
          }).pipe(withOp("getSuccessors")),

        // --- Iterators ---
        streamFrom: (from: RealPoint) =>
          Stream.fromEffect(
            Effect.all(
              [
                findImmutableFrom({ slot: Number(from.slot) }),
                findVolatileFrom({ slot: Number(from.slot) }),
              ],
              { concurrency: "unbounded" },
            ).pipe(
              // Merge both window halves and sort by slot (ES2025 `.toSorted`
              // — immutable). Since both queries now return the uniform
              // `BlockRow` shape, no per-half remap is needed.
              Effect.map(([iRows, vRows]) =>
                [...iRows, ...vRows].toSorted((a, b) => a.slot - b.slot),
              ),
              Effect.flatMap((rows) => Effect.forEach(rows, readBlockFromRow)),
              Effect.map((opts) => opts.flatMap(Option.toArray)),
              withOp("streamFrom"),
            ),
          ).pipe(Stream.flatMap(Stream.fromIterable)),

        // --- Immutable promotion (public entrypoint; `promoteBlocksEffect`
        //     is the driver-loop version used by the lifecycle reactor). ---
        promoteToImmutable: (upTo: RealPoint) =>
          promoteBlocksEffect(upTo).pipe(Effect.asVoid, withOp("promoteToImmutable")),

        // --- Garbage collection (public entrypoint mirrors the reactor's
        //     `collectGarbageEffect`). ---
        garbageCollect: (belowSlot: bigint) =>
          collectGarbageEffect(belowSlot).pipe(withOp("garbageCollect")),
      };
    }),
  );
