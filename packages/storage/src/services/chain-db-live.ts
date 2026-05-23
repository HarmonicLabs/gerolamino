/**
 * `ChainDB` Live Layer — BlobStore-only.
 *
 * Every chain-state operation goes through `BlobStore` (OPFS-backed LSM
 * WASM in chrome-ext via `LsmWorkerBrowser`; Zig/Haskell LSM on Bun).
 * No SQL, no Drizzle, no SQLite-WASM.
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
 * via `BlobStore.putBatch(...)` — LSM write batches (browser or Bun).
 * Rollback / promote / GC reuse the same batch primitive.
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
import { Context, Effect, Layer, Option, Ref, Stream } from "effect";
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

type BlobStoreApi = Context.Service.Shape<typeof BlobStore>;

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

const readBlock =
  (store: BlobStoreApi) =>
  (
    slot: bigint,
    hash: Uint8Array,
    metaKey: Uint8Array,
  ): Effect.Effect<Option.Option<StoredBlock>, unknown> =>
    Effect.all([store.get(metaKey), store.get(blockKey(slot, hash))], {
      concurrency: "unbounded",
    }).pipe(
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

const resolveHash = Effect.fn("ChainDBLive.resolveHash")(function* (
  store: BlobStoreApi,
  hash: Uint8Array,
) {
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

const getBlock = Effect.fn("ChainDBLive.getBlock")(function* (
  store: BlobStoreApi,
  hash: Uint8Array,
) {
  const resolved = yield* resolveHash(store, hash);
  if (Option.isNone(resolved)) return Option.none<StoredBlock>();
  return yield* readBlock(store)(resolved.value.slot, hash, resolved.value.metaKey);
});

const getBlockAt = Effect.fn("ChainDBLive.getBlockAt")(function* (
  store: BlobStoreApi,
  point: RealPoint,
) {
  const vMeta = yield* readBlock(store)(point.slot, point.hash, volatileMetaKey(point.slot, point.hash));
  if (Option.isSome(vMeta)) return vMeta;
  return yield* readBlock(store)(point.slot, point.hash, immutableMetaKey(point.slot, point.hash));
});

const addBlock = Effect.fn("ChainDBLive.addBlock")(function* (
  store: BlobStoreApi,
  summary: Ref.Ref<Summary>,
  block: StoredBlock,
) {
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
});

const collectVolatileMetas = (store: BlobStoreApi) =>
  Stream.runCollect(store.scan(PREFIX_VMET)).pipe(
    Effect.map((entries) => entries.map(({ key, value }) => ({ ...decodeMetaKey(key), value }))),
  );

const rollback = Effect.fn("ChainDBLive.rollback")(function* (
  store: BlobStoreApi,
  summary: Ref.Ref<Summary>,
  point: RealPoint,
) {
  const all = yield* collectVolatileMetas(store);
  const stale = all
    .map(({ slot, hash, value }) => ({ slot, hash, meta: decodeBlockMeta(value) }))
    .filter(({ slot }) => slot > point.slot);
  if (stale.length === 0) return;
  const deletes = stale.flatMap(({ slot, hash, meta }) => {
    const base = [volatileMetaKey(slot, hash), volatileByHashKey(hash), blockKey(slot, hash)];
    return meta.prevHash ? [...base, successorKey(meta.prevHash, slot, hash)] : base;
  });
  yield* store.deleteBatch(deletes);
  yield* store.put(volatileTipKey(), encodeTipValue(point.slot, point.hash));
  yield* Ref.update(summary, (s) => ({
    ...s,
    volatileCount: clamp(s.volatileCount - stale.length, 0, Number.MAX_SAFE_INTEGER),
    volatileTip: point,
  }));
});

const promoteToImmutable = Effect.fn("ChainDBLive.promoteToImmutable")(function* (
  store: BlobStoreApi,
  summary: Ref.Ref<Summary>,
  upTo: RealPoint,
) {
  const toPromote = (yield* collectVolatileMetas(store)).filter(({ slot }) => slot <= upTo.slot);
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
  // Sequential: promote (writes) THEN GC (deletes). Parallel batches raced —
  // a crash between delete-before-put left volatile empty while immutable
  // lacked the promoted entries (orphaned tip pointer).
  yield* store.putBatch(writes);
  yield* store.deleteBatch(deletes);
  yield* Ref.update(summary, (s) => ({
    ...s,
    volatileCount: clamp(s.volatileCount - toPromote.length, 0, Number.MAX_SAFE_INTEGER),
    immutableTip: upTo,
  }));
});

const garbageCollect = Effect.fn("ChainDBLive.garbageCollect")(function* (
  store: BlobStoreApi,
  summary: Ref.Ref<Summary>,
  belowSlot: bigint,
) {
  const stale = (yield* collectVolatileMetas(store))
    .map(({ slot, hash, value }) => ({ slot, hash, meta: decodeBlockMeta(value) }))
    .filter(({ slot }) => slot < belowSlot);
  if (stale.length === 0) return;
  const deletes = stale.flatMap(({ slot, hash, meta }) => {
    const base = [volatileMetaKey(slot, hash), volatileByHashKey(hash), blockKey(slot, hash)];
    return meta.prevHash ? [...base, successorKey(meta.prevHash, slot, hash)] : base;
  });
  yield* store.deleteBatch(deletes);
  yield* Ref.update(summary, (s) => ({
    ...s,
    volatileCount: clamp(s.volatileCount - stale.length, 0, Number.MAX_SAFE_INTEGER),
  }));
});

const bootSeedSummary = (store: BlobStoreApi, summary: Ref.Ref<Summary>) =>
  Effect.all(
    [store.get(volatileTipKey()), store.get(immutableTipKey()), Stream.runCount(store.scan(PREFIX_VMET))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap(([vTipBytes, iTipBytes, volatileCount]) =>
      Ref.set(summary, {
        volatileCount,
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
    // A hung BlobStore (LSM contention, IDB tx queueing) at boot would hang
    // startup. Cap at 5 s; empty summary is the correct cold-start fallback.
    withOp("bootSeed"),
    Effect.timeout("5 seconds"),
    Effect.catchCause((cause) =>
      Effect.logDebug("chain-db boot seed skipped").pipe(
        Effect.annotateLogs({ cause: String(cause) }),
      ),
    ),
  );

const streamFromCollect =
  (store: BlobStoreApi) =>
  (prefix: Uint8Array, from: RealPoint) =>
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

const streamFrom =
  (store: BlobStoreApi) =>
  (from: RealPoint): Stream.Stream<StoredBlock, ChainDBError> =>
    Stream.unwrap(
      Effect.all([streamFromCollect(store)(PREFIX_IMET, from), streamFromCollect(store)(PREFIX_VMET, from)], {
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

export const ChainDBLive: Layer.Layer<ChainDB, never, BlobStore> = Layer.effect(
  ChainDB,
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const summary = yield* Ref.make<Summary>(EMPTY_SUMMARY);
    yield* bootSeedSummary(store, summary);

    return {
      getBlock: (hash) => getBlock(store, hash).pipe(withOp("getBlock")),

      getBlockAt: (point) => getBlockAt(store, point).pipe(withOp("getBlockAt")),

      getTip: Ref.get(summary).pipe(
        Effect.map((s) => Option.fromNullishOr(s.volatileTip ?? s.immutableTip)),
        withOp("getTip"),
      ),

      getImmutableTip: Ref.get(summary).pipe(
        Effect.map((s) => Option.fromNullishOr(s.immutableTip)),
        withOp("getImmutableTip"),
      ),

      addBlock: (block) => addBlock(store, summary, block).pipe(withOp("addBlock")),

      writeBlobEntries: (entries) => store.putBatch(entries).pipe(withOp("writeBlobEntries")),

      deleteBlobEntries: (keys) => store.deleteBatch(keys).pipe(withOp("deleteBlobEntries")),

      rollback: (point) => rollback(store, summary, point).pipe(withOp("rollback")),

      getSuccessors: (hash) =>
        Stream.runCollect(store.scan(successorPrefix(hash))).pipe(
          Effect.map((entries) => entries.map((e) => decodeSuccessorHash(e.key))),
          withOp("getSuccessors"),
        ),

      streamFrom: streamFrom(store),

      promoteToImmutable: (upTo) =>
        promoteToImmutable(store, summary, upTo).pipe(withOp("promoteToImmutable")),

      garbageCollect: (belowSlot) =>
        garbageCollect(store, summary, belowSlot).pipe(withOp("garbageCollect")),
    };
  }),
);
