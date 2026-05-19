/**
 * `ChainDB` Live Layer — BlobStore-only.
 *
 * Every chain-state operation goes through `BlobStore` (IndexedDB-backed
 * in chrome-ext, LSM-backed on Bun). No SQL, no Drizzle, no
 * SQLite-WASM — the codebase no longer ships a SQL backend.
 *
 * A single `Ref<{volatileCount, volatileTip, immutableTip}>` holds the
 * summary statistics for fast `getTip` / `getImmutableTip`; tip
 * pointers are also persisted as singleton BlobStore entries
 * (`vtip` / `itip`) so a SW eviction restores them on boot.
 *
 * Storage layout (see `../blob-store/chain-keys.ts`):
 *   blk:{slot}{hash}    block CBOR (≤ 90 KB on Conway)
 *   vmet:{slot}{hash}   volatile  block metadata (44 B)
 *   imet:{slot}{hash}   immutable block metadata (44 B)
 *   vbyh:{hash}         volatile  hash → slot index (8 B)
 *   ibyh:{hash}         immutable hash → slot index (8 B)
 *   succ:{prev}{slot}{hash}    successor inverted index (empty value)
 *   vtip / itip                 tip-pointer singletons (40 B value)
 *
 * Each `addBlock` writes five keys (blk:, vmet:, vbyh:, succ:, vtip)
 * via `BlobStore.putBatch(...)` — IndexedDB scopes the batch to one
 * transaction; LSM (Bun) wraps it in a write batch. Either way it's
 * all-or-nothing. Rollback / promote / GC reuse the same batch
 * primitive.
 *
 * Big-O profile:
 *   getBlock(hash):           2 reads (vbyh → vmet → blk: cascade)
 *   getBlockAt(point):        1 read  (direct vmet / imet lookup)
 *   addBlock:                 5 writes (one batch)
 *   rollback(point):          1 scan + N batch deletes (N = blocks above point)
 *   getSuccessors(parent):    1 prefix scan over `succ:{parent}`
 *   streamFrom(point):        2 prefix scans (vmet + imet) merged in slot order
 *   promoteToImmutable(upTo): 1 scan + N batch writes/deletes (N = blocks ≤ upTo)
 *   garbageCollect(below):    1 scan + N batch deletes (N = blocks < below)
 */
import { Effect, Layer, Option, Ref, Stream } from "effect";
import { clamp, orderBy } from "es-toolkit";
import { ChainDB, ChainDBError, type ChainDBOperation } from "./chain-db.ts";
import { type BlobEntry, BlobStore, blockKey } from "../blob-store";
import {
  decodeBlockMeta,
  decodeByHashValue,
  decodeMetaKey,
  decodeSuccessorHash,
  decodeTipValue,
  encodeBlockMeta,
  encodeByHashValue,
  encodeTipValue,
  immutableByHashKey,
  immutableMetaKey,
  immutableTipKey,
  PREFIX_IMET,
  PREFIX_VMET,
  successorKey,
  successorPrefix,
  volatileByHashKey,
  volatileMetaKey,
  volatileTipKey,
} from "../blob-store/chain-keys.ts";
import { StoredBlock, RealPoint } from "../types/StoredBlock.ts";

const withOp =
  (operation: ChainDBOperation) =>
  <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, ChainDBError, R> =>
    Effect.mapError(effect, (cause) => new ChainDBError({ operation, cause }));

/** Summary state cached in-memory for O(1) `getTip` / `getImmutableTip`
 *  / volatile-count queries. Tip pointers are also persisted to
 *  BlobStore (`vtip` / `itip`) so a cold restart can restore this state
 *  without a full prefix scan. The `count` is the number of volatile
 *  blocks; consumers (consensus engine) compare against the security
 *  parameter `k` to decide when to promote. */
type Summary = {
  readonly volatileCount: number;
  readonly volatileTip: RealPoint | undefined;
  readonly immutableTip: RealPoint | undefined;
};

const EMPTY_SUMMARY: Summary = {
  volatileCount: 0,
  volatileTip: undefined,
  immutableTip: undefined,
};

const pointFromMetaKey = (key: Uint8Array): RealPoint => {
  const { slot, hash } = decodeMetaKey(key);
  return { slot, hash };
};

export const ChainDBLive: Layer.Layer<ChainDB, never, BlobStore> = Layer.effect(
  ChainDB,
  Effect.gen(function* () {
    const store = yield* BlobStore;

    const summary = yield* Ref.make<Summary>(EMPTY_SUMMARY);
    // Boot seed: load tip pointers + volatile-count from BlobStore so a
    // cold restart restores the in-memory summary cache. Composed
    // applicatively (`Effect.all` + `flatMap`) instead of an inner
    // `Effect.gen` — avoids the forbidden nested generator pattern.
    const seedSummary = Effect.all(
      [
        store.get(volatileTipKey()),
        store.get(immutableTipKey()),
        Stream.runCollect(store.scan(PREFIX_VMET)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.flatMap(([vTipBytes, iTipBytes, volatileMetas]) =>
        Ref.set(summary, {
          volatileCount: volatileMetas.length,
          volatileTip: Option.match(vTipBytes, {
            onNone: () => undefined,
            onSome: (b) => decodeTipValue(b),
          }),
          immutableTip: Option.match(iTipBytes, {
            onNone: () => undefined,
            onSome: (b) => decodeTipValue(b),
          }),
        }),
      ),
      // A hung BlobStore (LSM contention, IDB tx queueing) at boot would
      // hang the entire startup path. Cap the seed at 5 s and treat the
      // timeout as a recoverable cold-start: the empty summary is the
      // correct fallback — the volatile region rebuilds itself from the
      // persisted vtip/itip on the next addBlock.
      Effect.timeout("5 seconds"),
      Effect.catchCause((cause) =>
        Effect.logDebug("chain-db boot seed skipped").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
    );
    yield* seedSummary;

    const readBlock = (
      slot: bigint,
      hash: Uint8Array,
      metaKey: Uint8Array,
    ): Effect.Effect<Option.Option<StoredBlock>, unknown> =>
      // Applicative composition over `Effect.all → Effect.map`. The prior
      // shape used an inner `Effect.gen` for one yield + one synchronous
      // assemble; the `.pipe(Effect.map(…))` form keeps `readBlock` flat
      // and composes cleanly with the outer `withOp(…)` wrapper at every
      // call site.
      Effect.all(
        [store.get(metaKey), store.get(blockKey(slot, hash))],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(([metaOpt, cborOpt]) => {
          if (Option.isNone(metaOpt) || Option.isNone(cborOpt)) return Option.none<StoredBlock>();
          const meta = decodeBlockMeta(metaOpt.value);
          return Option.some<StoredBlock>({
            slot,
            hash,
            blockNo: meta.blockNo,
            blockSizeBytes: meta.sizeBytes,
            blockCbor: cborOpt.value,
            ...(meta.prevHash ? { prevHash: meta.prevHash } : {}),
          });
        }),
      );

    const resolveHash = (
      hash: Uint8Array,
    ): Effect.Effect<Option.Option<{ slot: bigint; metaKey: Uint8Array }>, unknown> =>
      Effect.gen(function* () {
        const vSlotBytes = yield* store.get(volatileByHashKey(hash));
        if (Option.isSome(vSlotBytes)) {
          const slot = decodeByHashValue(vSlotBytes.value);
          return Option.some({ slot, metaKey: volatileMetaKey(slot, hash) });
        }
        const iSlotBytes = yield* store.get(immutableByHashKey(hash));
        return Option.map(iSlotBytes, (b) => {
          const slot = decodeByHashValue(b);
          return { slot, metaKey: immutableMetaKey(slot, hash) };
        });
      });

    return {
      getBlock: (hash) =>
        Effect.gen(function* () {
          const resolved = yield* resolveHash(hash);
          if (Option.isNone(resolved)) return Option.none<StoredBlock>();
          return yield* readBlock(resolved.value.slot, hash, resolved.value.metaKey);
        }).pipe(withOp("getBlock")),

      getBlockAt: (point) =>
        Effect.gen(function* () {
          const vMeta = yield* readBlock(
            point.slot,
            point.hash,
            volatileMetaKey(point.slot, point.hash),
          );
          if (Option.isSome(vMeta)) return vMeta;
          return yield* readBlock(
            point.slot,
            point.hash,
            immutableMetaKey(point.slot, point.hash),
          );
        }).pipe(withOp("getBlockAt")),

      getTip: Ref.get(summary).pipe(
        Effect.map((s) => Option.fromNullishOr(s.volatileTip ?? s.immutableTip)),
        withOp("getTip"),
      ),

      getImmutableTip: Ref.get(summary).pipe(
        Effect.map((s) => Option.fromNullishOr(s.immutableTip)),
        withOp("getImmutableTip"),
      ),

      addBlock: (block) =>
        Effect.gen(function* () {
          const tipPoint: RealPoint = { slot: block.slot, hash: block.hash };
          const entries: BlobEntry[] = [
            { key: blockKey(block.slot, block.hash), value: block.blockCbor },
            {
              key: volatileMetaKey(block.slot, block.hash),
              value: encodeBlockMeta(block.blockNo, block.prevHash ?? null, block.blockSizeBytes),
            },
            { key: volatileByHashKey(block.hash), value: encodeByHashValue(block.slot) },
            ...(block.prevHash
              ? [
                  {
                    key: successorKey(block.prevHash, block.slot, block.hash),
                    value: new Uint8Array(0),
                  },
                ]
              : []),
            { key: volatileTipKey(), value: encodeTipValue(block.slot, block.hash) },
          ];
          yield* store.putBatch(entries);
          yield* Ref.update(summary, (s) => ({
            ...s,
            volatileCount: s.volatileCount + 1,
            volatileTip: tipPoint,
          }));
        }).pipe(withOp("addBlock")),

      writeBlobEntries: (entries) => store.putBatch(entries).pipe(withOp("writeBlobEntries")),

      deleteBlobEntries: (keys) => store.deleteBatch(keys).pipe(withOp("deleteBlobEntries")),

      rollback: (point) =>
        Effect.gen(function* () {
          // Decode each volatile meta entry exactly once, then derive the
          // delete-key list via flatMap. Stale entries are above the
          // rollback point; each contributes 3-4 keys (vmet, vbyh, blk:,
          // and succ when prevHash is non-null).
          const all = yield* Stream.runCollect(store.scan(PREFIX_VMET));
          const stale = all
            .map(({ key, value }) => ({ ...decodeMetaKey(key), meta: decodeBlockMeta(value) }))
            .filter(({ slot }) => slot > point.slot);
          if (stale.length === 0) return;
          const deletes = stale.flatMap(({ slot, hash, meta }) => {
            const base = [
              volatileMetaKey(slot, hash),
              volatileByHashKey(hash),
              blockKey(slot, hash),
            ];
            return meta.prevHash ? [...base, successorKey(meta.prevHash, slot, hash)] : base;
          });
          yield* store.deleteBatch(deletes);
          yield* store.put(volatileTipKey(), encodeTipValue(point.slot, point.hash));
          yield* Ref.update(summary, (s) => ({
            ...s,
            volatileCount: clamp(s.volatileCount - stale.length, 0, Number.MAX_SAFE_INTEGER),
            volatileTip: point,
          }));
        }).pipe(withOp("rollback")),

      getSuccessors: (hash) =>
        Stream.runCollect(store.scan(successorPrefix(hash))).pipe(
          Effect.map((entries) => entries.map((e) => decodeSuccessorHash(e.key))),
          withOp("getSuccessors"),
        ),

      streamFrom: (from) => {
        // `orderBy` declares "sort by slot ASC, hash ASC" without the
        // manual cascade comparator. Hashes are 32 bytes encoded as
        // hex; lex order on the hex string equals byte order on the
        // underlying buffer (one-to-one BE encoding), so we stay
        // numerically equivalent to the prior `compareBytes` callback.
        const collect = (prefix: Uint8Array) =>
          Stream.runCollect(store.scan(prefix)).pipe(
            Effect.map((arr) =>
              orderBy(
                arr
                  .map(({ key, value }) => ({ point: pointFromMetaKey(key), metaValue: value }))
                  .filter(({ point }) => point.slot >= from.slot),
                [(x) => x.point.slot, (x) => x.point.hash.toHex()],
                ["asc", "asc"],
              ),
            ),
          );
        // Single-yield gen → `.pipe` chain (audit F50 / F-pipe-flatten).
        // `Effect.all` collects both prefix scans concurrently;
        // `Effect.map` projects the tuple into the merged Stream;
        // `Effect.mapError` covers the collect-time failure path.
        // `Stream.unwrap` lifts the resulting `Effect<Stream>` into a
        // bare `Stream` for the service shape.
        return Stream.unwrap(
          Effect.all([collect(PREFIX_IMET), collect(PREFIX_VMET)], {
            concurrency: "unbounded",
          }).pipe(
            Effect.map(([imm, vol]) =>
              Stream.fromIterable([...imm, ...vol]).pipe(
                Stream.flatMap(({ point, metaValue }) =>
                  Stream.fromEffect(store.get(blockKey(point.slot, point.hash))).pipe(
                    Stream.flatMap((cborOpt) => {
                      if (Option.isNone(cborOpt)) return Stream.empty;
                      const meta = decodeBlockMeta(metaValue);
                      const block: StoredBlock = {
                        slot: point.slot,
                        hash: point.hash,
                        blockNo: meta.blockNo,
                        blockSizeBytes: meta.sizeBytes,
                        blockCbor: cborOpt.value,
                        ...(meta.prevHash ? { prevHash: meta.prevHash } : {}),
                      };
                      return Stream.succeed(block);
                    }),
                  ),
                ),
                Stream.mapError((cause) => new ChainDBError({ operation: "streamFrom", cause })),
              ),
            ),
            Effect.mapError((cause) => new ChainDBError({ operation: "streamFrom", cause })),
          ),
        );
      },

      promoteToImmutable: (upTo) =>
        Effect.gen(function* () {
          // Decode meta keys + values once, project into writes + deletes
          // arrays via flatMap. Each promoted entry contributes 2 writes
          // (imet, ibyh) and 2 deletes (vmet, vbyh).
          const toPromote = (yield* Stream.runCollect(store.scan(PREFIX_VMET)))
            .map(({ key, value }) => ({ ...decodeMetaKey(key), value }))
            .filter(({ slot }) => slot <= upTo.slot);
          if (toPromote.length === 0) return;
          const writes: BlobEntry[] = [
            ...toPromote.flatMap(({ slot, hash, value }) => [
              { key: immutableMetaKey(slot, hash), value },
              { key: immutableByHashKey(hash), value: encodeByHashValue(slot) },
            ]),
            { key: immutableTipKey(), value: encodeTipValue(upTo.slot, upTo.hash) },
          ];
          const deletes = toPromote.flatMap(({ slot, hash }) => [
            volatileMetaKey(slot, hash),
            volatileByHashKey(hash),
          ]);
          // Sequential: promote (writes) THEN GC (deletes). The previous
          // `Effect.all([…], { concurrency: "unbounded" })` raced — if the
          // delete batch landed before the put batch, a crash in between
          // left the volatile region empty for those slots while the
          // immutable region was missing the moved entries (orphaned tip
          // pointer). One extra IDB round-trip vs total loss of the
          // promoted region.
          yield* store.putBatch(writes);
          yield* store.deleteBatch(deletes);
          yield* Ref.update(summary, (s) => ({
            ...s,
            volatileCount: clamp(s.volatileCount - toPromote.length, 0, Number.MAX_SAFE_INTEGER),
            immutableTip: upTo,
          }));
        }).pipe(withOp("promoteToImmutable")),

      garbageCollect: (belowSlot) =>
        Effect.gen(function* () {
          // Volatile-only GC — immutable blocks are k-deep-stable and
          // never collected. Same shape as `rollback` but with the
          // opposite slot predicate (older instead of newer).
          const stale = (yield* Stream.runCollect(store.scan(PREFIX_VMET)))
            .map(({ key, value }) => ({ ...decodeMetaKey(key), meta: decodeBlockMeta(value) }))
            .filter(({ slot }) => slot < belowSlot);
          if (stale.length === 0) return;
          const deletes = stale.flatMap(({ slot, hash, meta }) => {
            const base = [
              volatileMetaKey(slot, hash),
              volatileByHashKey(hash),
              blockKey(slot, hash),
            ];
            return meta.prevHash ? [...base, successorKey(meta.prevHash, slot, hash)] : base;
          });
          yield* store.deleteBatch(deletes);
          yield* Ref.update(summary, (s) => ({
            ...s,
            volatileCount: clamp(s.volatileCount - stale.length, 0, Number.MAX_SAFE_INTEGER),
          }));
        }).pipe(withOp("garbageCollect")),
    };
  }),
);
