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
import { Config, Effect, Layer, Option, Queue, Schema, Stream, SubscriptionRef } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
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
import { IMMUTABLE_BLOCK_DEFAULTS, timeUnixSeconds } from "../operations/blocks.ts";
import { ChainDBEvent, type ChainDBState, initialChainDBState, reduce } from "../machines";
import { StoredBlock, RealPoint } from "../types/StoredBlock.ts";

/** Tag an effect's failures as a `ChainDBError` with the given operation name.
 * `operation` is typed to the `ChainDBOperation` union so typos fail at
 * compile time (the error class's Schema would accept anything at runtime
 * but TS narrows the input). */
const withOp =
  (operation: ChainDBOperation) =>
  <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, ChainDBError, R> =>
    Effect.mapError(effect, (cause) => new ChainDBError({ operation, cause }));

// ---------------------------------------------------------------------------
// Row schemas — type-safe SQL result decoding
// ---------------------------------------------------------------------------

/** Both `volatile_blocks` and `immutable_blocks` expose the same logical
 *  shape (hash, slot, prev_hash, block_no, size); the only physical diff is
 *  the size column's name (`block_size_bytes` vs `size`), which we paper
 *  over by aliasing `immutable_blocks.size AS block_size_bytes` in every
 *  SELECT. One schema + one row reader + uniform `streamFrom` merge. */
const BlockRow = Schema.Struct({
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

/** Lift a decoded `PointRow` into the bigint-slot `RealPoint` shape. */
const toPoint = (r: typeof PointRow.Type): RealPoint => ({
  slot: BigInt(r.slot),
  hash: r.hash,
});

/** Default security param (k) — overridable via SECURITY_PARAM env. */
const securityParamConfig = Config.number("SECURITY_PARAM").pipe(Config.withDefault(2160));

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
       *  exists but the BlobStore has no blob (stale index / GC race). */
      const readBlockFromRow = (r: typeof BlockRow.Type) =>
        Effect.map(
          store.get(blockKey(BigInt(r.slot), r.hash)),
          Option.map(
            (blockCbor): StoredBlock => ({
              slot: BigInt(r.slot),
              hash: r.hash,
              blockNo: BigInt(r.block_no),
              blockSizeBytes: r.block_size_bytes,
              blockCbor,
              ...(r.prev_hash ? { prevHash: r.prev_hash } : {}),
            }),
          ),
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

      const findVolatileByHash = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array }),
        Result: BlockRow,
        execute: (req) => sql`
          SELECT hash, slot, prev_hash, block_no, block_size_bytes
          FROM volatile_blocks WHERE hash = ${req.hash} LIMIT 1
        `,
      });

      const findImmutableByHash = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array }),
        Result: BlockRow,
        execute: (req) => sql`
          SELECT hash, slot, prev_hash, block_no, size AS block_size_bytes
          FROM immutable_blocks WHERE hash = ${req.hash} LIMIT 1
        `,
      });

      const findVolatileByPoint = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array, slot: Schema.Number }),
        Result: BlockRow,
        execute: (req) => sql`
          SELECT hash, slot, prev_hash, block_no, block_size_bytes
          FROM volatile_blocks
          WHERE hash = ${req.hash} AND slot = ${req.slot} LIMIT 1
        `,
      });

      const findImmutableByPoint = SqlSchema.findOneOption({
        Request: Schema.Struct({ hash: Schema.Uint8Array, slot: Schema.Number }),
        Result: BlockRow,
        execute: (req) => sql`
          SELECT hash, slot, prev_hash, block_no, size AS block_size_bytes
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

      const findVolatileBelowSlot = SqlSchema.findAll({
        Request: Schema.Struct({ belowSlot: Schema.Number }),
        Result: PointRow,
        execute: (req) => sql`
          SELECT slot, hash FROM volatile_blocks WHERE slot < ${req.belowSlot}
        `,
      });

      const findVolatileAboveSlot = SqlSchema.findAll({
        Request: Schema.Struct({ slot: Schema.Number }),
        Result: PointRow,
        execute: (req) => sql`
          SELECT slot, hash FROM volatile_blocks WHERE slot > ${req.slot}
        `,
      });

      const findImmutableFrom = SqlSchema.findAll({
        Request: Schema.Struct({ slot: Schema.Number }),
        Result: BlockRow,
        execute: (req) => sql`
          SELECT slot, hash, prev_hash, block_no, size AS block_size_bytes
          FROM immutable_blocks WHERE slot > ${req.slot} ORDER BY slot ASC
        `,
      });

      const findVolatileFrom = SqlSchema.findAll({
        Request: Schema.Struct({ slot: Schema.Number }),
        Result: BlockRow,
        execute: (req) => sql`
          SELECT hash, slot, prev_hash, block_no, block_size_bytes
          FROM volatile_blocks WHERE slot > ${req.slot} ORDER BY slot ASC
        `,
      });

      const findToPromote = SqlSchema.findAll({
        Request: Schema.Struct({ slot: Schema.Number }),
        Result: BlockRow,
        execute: (req) => sql`
          SELECT hash, slot, prev_hash, block_no, block_size_bytes
          FROM volatile_blocks WHERE slot <= ${req.slot} ORDER BY slot ASC
        `,
      });

      const promoteBlocksEffect = (tip: RealPoint) =>
        Effect.gen(function* () {
          const time = yield* timeUnixSeconds;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* findToPromote({ slot: Number(tip.slot) });
              if (rows.length > 0) {
                // Single multi-VALUES insert using `sql.insert` (Effect
                // `Statement.ts:368`) + SQLite ON CONFLICT DO UPDATE with
                // `excluded.hash` to reuse the row being inserted.
                yield* sql`INSERT INTO immutable_blocks ${sql.insert(
                  rows.map((r) => ({
                    slot: r.slot,
                    hash: r.hash,
                    prev_hash: r.prev_hash,
                    block_no: r.block_no,
                    size: r.block_size_bytes,
                    time,
                    ...IMMUTABLE_BLOCK_DEFAULTS,
                  })),
                )}
                  ON CONFLICT(slot) DO UPDATE SET hash = excluded.hash`;
              }
              yield* sql`DELETE FROM volatile_blocks WHERE slot <= ${Number(tip.slot)}`;
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
            yield* sql`DELETE FROM volatile_blocks WHERE slot < ${Number(belowSlot)}`;
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
        execute: () => sql`SELECT COUNT(*) AS n FROM volatile_blocks`,
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
              const tip = s.tip;
              return promoteBlocksEffect(tip).pipe(
                Effect.matchCauseEffect({
                  onSuccess: (promoted) =>
                    Queue.offer(events, ChainDBEvent.cases.PromoteDone.make({ promoted })),
                  onFailure: (cause) =>
                    Queue.offer(events, ChainDBEvent.cases.PromoteFailed.make({ error: cause })),
                }),
              );
            }
            if (s.immutability === "gc") {
              const belowSlot = s.immutableTip?.slot ?? 0n;
              return collectGarbageEffect(belowSlot).pipe(
                Effect.matchCauseEffect({
                  onSuccess: () => Queue.offer(events, ChainDBEvent.cases.GcDone.make({})),
                  onFailure: (cause) =>
                    Queue.offer(events, ChainDBEvent.cases.GcFailed.make({ error: cause })),
                }),
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
            // Build block_index entry: bidx + blockNo(8B BE) → slot(8B BE) + hash(32B)
            const idxVal = new Uint8Array(40);
            const idxView = new DataView(idxVal.buffer);
            idxView.setBigUint64(0, block.slot, false);
            idxVal.set(block.hash, 8);

            // Analyze block CBOR for tx offsets (works on full blocks; no-ops on headers).
            // Malformed blocks surface as `BlockAnalysisParseError`; swallow to empty here
            // — the callers' upstream path (consensus validation) rejects invalid blocks
            // before they ever reach `PROMOTE`, so a parse failure at this layer means a
            // synthetic / legacy block that we still want to index without offsets.
            const analysis = yield* analyzeBlockCbor(block.blockCbor).pipe(
              Effect.orElseSucceed((): BlockAnalysis => ({ blockNo: 0n, txOffsets: [] })),
            );
            const offsetEntries: ReadonlyArray<BlobEntry> = analysis.txOffsets.map((o, i) => {
              const val = new Uint8Array(8);
              const dv = new DataView(val.buffer);
              dv.setUint32(0, o.offset, false);
              dv.setUint32(4, o.size, false);
              return { key: cborOffsetKey(block.slot, i), value: val };
            });

            yield* sql.withTransaction(
              Effect.all(
                [
                  store.put(blockKey(block.slot, block.hash), block.blockCbor),
                  store.put(blockIndexKey(block.blockNo), idxVal),
                  offsetEntries.length > 0 ? store.putBatch(offsetEntries) : Effect.void,
                  sql`INSERT INTO volatile_blocks ${sql.insert({
                    hash: block.hash,
                    slot: Number(block.slot),
                    prev_hash: block.prevHash ?? null,
                    block_no: Number(block.blockNo),
                    block_size_bytes: block.blockSizeBytes,
                  })} ON CONFLICT(hash) DO NOTHING`,
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
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const rows = yield* findVolatileAboveSlot({ slot: Number(point.slot) });
                if (rows.length > 0) {
                  yield* store.deleteBatch(rows.map((r) => blockKey(BigInt(r.slot), r.hash)));
                }
                yield* sql`DELETE FROM volatile_blocks WHERE slot > ${Number(point.slot)}`;
              }),
            );

            yield* Queue.offer(events, ChainDBEvent.cases.Rollback.make({ point }));
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
