/**
 * `ChainDB` — BlobStore-only Layer for chrome-ext SW.
 *
 * Drop-in for `ChainDBLive` in environments without SQL. Same service
 * tag, same error type — consumers (consensus engine, RPC) can't tell
 * which Layer is wired in.
 *
 * Architecture (vs the SQL sibling):
 *   - **No SQL, no Drizzle, no SQLite-WASM**. Every chain-state
 *     operation goes through `BlobStore` (IndexedDB-backed in
 *     chrome-ext, LSM-backed on Bun if anyone wants the same Layer
 *     there).
 *   - **No reducer / SubscriptionRef / Queue**. The SQL sibling runs
 *     a 3-fiber lifecycle (dispatch / driver / reactor) for live
 *     immutability-region transitions. chrome-ext doesn't need them:
 *     the dashboard reads its own atom feed (pushed by the consensus
 *     layer via `delta.ts`), not internal `ChainDB` state. A single
 *     `Ref<{volatileCount, volatileTip, immutableTip}>` holds the
 *     summary statistics for fast `getTip` / `getImmutableTip`; tip
 *     pointers are also persisted as singleton BlobStore entries
 *     (`vtip` / `itip`) so a SW eviction restores them on boot.
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
import { compareBytes } from "codecs";
import { ChainDB, ChainDBError, type ChainDBOperation } from "./chain-db.ts";
import {
  type BlobEntry,
  BlobStore,
  blockKey,
} from "../blob-store";
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

/** Tag an effect's failures as a `ChainDBError`. Identical helper to
 *  the SQL sibling's `withOp` so call-site idioms read the same. */
const withOp =
  (operation: ChainDBOperation) =>
  <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, ChainDBError, R> =>
    Effect.mapError(effect, (cause) => new ChainDBError({ operation, cause }));

/** Summary state cached in-memory for O(1) `getTip` / `getImmutableTip`
 *  / volatile-count queries. Tip pointers are also persisted to
 *  BlobStore (`vtip` / `itip`) so a cold SW restart can restore this
 *  state without a full prefix scan. The `count` is the number of
 *  volatile blocks; consumers (consensus engine) compare against the
 *  security parameter `k` to decide when to promote. */
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

/** Compose a `RealPoint` from key bytes — bytes 4..12 = slot (BE),
 *  bytes 12..44 = hash. */
const pointFromMetaKey = (key: Uint8Array): RealPoint => {
  const { slot, hash } = decodeMetaKey(key);
  return { slot, hash };
};

/** BlobStore-only Layer for `ChainDB`. Depends ONLY on `BlobStore` —
 *  intentionally no `SqlClient`. */
export const ChainDBBlobOnlyLive: Layer.Layer<ChainDB, never, BlobStore> = Layer.effect(
  ChainDB,
  Effect.gen(function* () {
    const store = yield* BlobStore;

    // ────────────────────────────────────────────────────────────────────
    // Summary state — initialized from persistent BlobStore singletons
    // (vtip / itip) plus a single prefix scan to re-derive
    // volatileCount. Runs once at layer init. Misses fall through to
    // `EMPTY_SUMMARY` so a fresh DB boots cleanly.
    // ────────────────────────────────────────────────────────────────────
    const summary = yield* Ref.make<Summary>(EMPTY_SUMMARY);
    yield* Effect.gen(function* () {
      const [vTipBytes, iTipBytes, volatileMetas] = yield* Effect.all(
        [
          store.get(volatileTipKey()),
          store.get(immutableTipKey()),
          Stream.runCollect(store.scan(PREFIX_VMET)),
        ],
        { concurrency: "unbounded" },
      );
      yield* Ref.set(summary, {
        volatileCount: volatileMetas.length,
        volatileTip: Option.match(vTipBytes, {
          onNone: () => undefined,
          onSome: (b) => decodeTipValue(b),
        }),
        immutableTip: Option.match(iTipBytes, {
          onNone: () => undefined,
          onSome: (b) => decodeTipValue(b),
        }),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("chain-db-blob-only boot seed skipped").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
    );

    // ────────────────────────────────────────────────────────────────────
    // Helpers — block hydration + tip-pointer maintenance.
    // ────────────────────────────────────────────────────────────────────

    /** Read block CBOR + metadata, fold into a `StoredBlock`. Returns
     *  `None` if either the metadata key or the CBOR blob is absent. */
    const readBlock = (
      slot: bigint,
      hash: Uint8Array,
      metaKey: Uint8Array,
    ): Effect.Effect<Option.Option<StoredBlock>, unknown> =>
      Effect.gen(function* () {
        const [metaOpt, cborOpt] = yield* Effect.all(
          [store.get(metaKey), store.get(blockKey(slot, hash))],
          { concurrency: "unbounded" },
        );
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
      });

    /** Resolve `(slot, region)` from a hash via the by-hash inverted
     *  indexes. Tries volatile first (per spec 12.1.1), falls back to
     *  immutable. Returns `None` if the hash isn't tracked. */
    const resolveHash = (
      hash: Uint8Array,
    ): Effect.Effect<
      Option.Option<{ slot: bigint; metaKey: Uint8Array }>,
      unknown
    > =>
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
          // Try volatile region first, fall back to immutable.
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
            // Block CBOR (already keyed by `blk:`).
            { key: blockKey(block.slot, block.hash), value: block.blockCbor },
            // Volatile metadata.
            {
              key: volatileMetaKey(block.slot, block.hash),
              value: encodeBlockMeta(block.blockNo, block.prevHash ?? null, block.blockSizeBytes),
            },
            // Hash → slot index (for `getBlock(hash)`).
            { key: volatileByHashKey(block.hash), value: encodeByHashValue(block.slot) },
            // Successor inverted index. Genesis blocks (no prevHash)
            // skip this — there's no parent to register against.
            ...(block.prevHash
              ? [
                  {
                    key: successorKey(block.prevHash, block.slot, block.hash),
                    value: new Uint8Array(0),
                  },
                ]
              : []),
            // Volatile tip pointer (singleton).
            { key: volatileTipKey(), value: encodeTipValue(block.slot, block.hash) },
          ];
          yield* store.putBatch(entries);
          // Update summary in-memory; `volatileCount` may overcount on
          // a duplicate-hash add, but the underlying upsert semantics
          // (BlobStore overwrites) keep storage consistent.
          yield* Ref.update(summary, (s) => ({
            ...s,
            volatileCount: s.volatileCount + 1,
            volatileTip: tipPoint,
          }));
        }).pipe(withOp("addBlock")),

      writeBlobEntries: (entries) =>
        store.putBatch(entries).pipe(withOp("writeBlobEntries")),

      deleteBlobEntries: (keys) =>
        store.deleteBatch(keys).pipe(withOp("deleteBlobEntries")),

      rollback: (point) =>
        Effect.gen(function* () {
          // Scan all volatile metadata above the rollback slot. We need
          // the metadata to know `prevHash` for successor-key cleanup.
          const all = yield* Stream.runCollect(store.scan(PREFIX_VMET));
          const stale = all.filter(({ key }) => decodeMetaKey(key).slot > point.slot);
          if (stale.length === 0) return;
          // For each stale block, delete five keys: vmet, vbyh, blk:,
          // succ entry (if non-genesis), and the volatile tip pointer.
          // The tip pointer is rewritten below, not in the same batch.
          const deletes: Uint8Array[] = [];
          for (const { key, value } of stale) {
            const { slot, hash } = decodeMetaKey(key);
            const meta = decodeBlockMeta(value);
            deletes.push(
              volatileMetaKey(slot, hash),
              volatileByHashKey(hash),
              blockKey(slot, hash),
            );
            if (meta.prevHash) deletes.push(successorKey(meta.prevHash, slot, hash));
          }
          yield* store.deleteBatch(deletes);
          // Rewrite vtip to the rollback point.
          yield* store.put(volatileTipKey(), encodeTipValue(point.slot, point.hash));
          yield* Ref.update(summary, (s) => ({
            ...s,
            volatileCount: Math.max(0, s.volatileCount - stale.length),
            volatileTip: point,
          }));
        }).pipe(withOp("rollback")),

      getSuccessors: (hash) =>
        Stream.runCollect(store.scan(successorPrefix(hash))).pipe(
          Effect.map((entries) => entries.map((e) => decodeSuccessorHash(e.key))),
          withOp("getSuccessors"),
        ),

      streamFrom: (from) => {
        // Merge volatile + immutable scans in slot ASC order. Both
        // streams are pre-sorted (lex on big-endian slot keys), so a
        // simple "consume immutable until ≥ from.slot, then volatile"
        // produces the chain in canonical order. We materialize each
        // stream once (via `runCollect`) and concat — chain depth is
        // bounded by k for volatile and the practical history horizon
        // for immutable, both well under the chunk limit.
        const collect = (prefix: Uint8Array) =>
          Stream.runCollect(store.scan(prefix)).pipe(
            Effect.map((arr) =>
              arr
                .map(({ key, value }) => ({ point: pointFromMetaKey(key), metaValue: value }))
                .filter(({ point }) => point.slot >= from.slot)
                .toSorted((a, b) => {
                  // Stable sort: slot ASC, then hash byte order.
                  if (a.point.slot < b.point.slot) return -1;
                  if (a.point.slot > b.point.slot) return 1;
                  return compareBytes(a.point.hash, b.point.hash);
                }),
            ),
          );
        return Stream.unwrap(
          Effect.gen(function* () {
            const [imm, vol] = yield* Effect.all(
              [collect(PREFIX_IMET), collect(PREFIX_VMET)],
              { concurrency: "unbounded" },
            );
            return Stream.fromIterable([...imm, ...vol]).pipe(
              // Hydrate block CBOR per row. Missing-blob rows (stale
              // metadata vs GC race) emit `Stream.empty`, dropping
              // them silently; otherwise emit the `StoredBlock`.
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
            );
          }).pipe(
            Effect.mapError((cause) => new ChainDBError({ operation: "streamFrom", cause })),
          ),
        );
      },

      promoteToImmutable: (upTo) =>
        Effect.gen(function* () {
          // Scan all volatile metadata at-or-below `upTo.slot`. Move
          // each entry to the immutable region by writing the matching
          // `imet` / `ibyh` keys and deleting the `vmet` / `vbyh` ones.
          // The block CBOR (`blk:`) doesn't move.
          const all = yield* Stream.runCollect(store.scan(PREFIX_VMET));
          const toPromote = all.filter(({ key }) => decodeMetaKey(key).slot <= upTo.slot);
          if (toPromote.length === 0) return;
          const writes: BlobEntry[] = [];
          const deletes: Uint8Array[] = [];
          for (const { key, value } of toPromote) {
            const { slot, hash } = decodeMetaKey(key);
            writes.push(
              { key: immutableMetaKey(slot, hash), value },
              { key: immutableByHashKey(hash), value: encodeByHashValue(slot) },
            );
            deletes.push(volatileMetaKey(slot, hash), volatileByHashKey(hash));
          }
          // Update the immutable tip pointer to `upTo`.
          writes.push({
            key: immutableTipKey(),
            value: encodeTipValue(upTo.slot, upTo.hash),
          });
          yield* Effect.all(
            [store.putBatch(writes), store.deleteBatch(deletes)],
            { concurrency: "unbounded" },
          );
          yield* Ref.update(summary, (s) => ({
            ...s,
            volatileCount: Math.max(0, s.volatileCount - toPromote.length),
            immutableTip: upTo,
          }));
        }).pipe(withOp("promoteToImmutable")),

      garbageCollect: (belowSlot) =>
        Effect.gen(function* () {
          // Volatile-only GC — immutable blocks are k-deep-stable and
          // never collected. Removes blocks with slot < belowSlot from
          // the volatile region, plus their CBOR + successor entries.
          const all = yield* Stream.runCollect(store.scan(PREFIX_VMET));
          const stale = all.filter(({ key }) => decodeMetaKey(key).slot < belowSlot);
          if (stale.length === 0) return;
          const deletes: Uint8Array[] = [];
          for (const { key, value } of stale) {
            const { slot, hash } = decodeMetaKey(key);
            const meta = decodeBlockMeta(value);
            deletes.push(
              volatileMetaKey(slot, hash),
              volatileByHashKey(hash),
              blockKey(slot, hash),
            );
            if (meta.prevHash) deletes.push(successorKey(meta.prevHash, slot, hash));
          }
          yield* store.deleteBatch(deletes);
          yield* Ref.update(summary, (s) => ({
            ...s,
            volatileCount: Math.max(0, s.volatileCount - stale.length),
          }));
        }).pipe(withOp("garbageCollect")),
    };
  }),
);
