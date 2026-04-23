/**
 * ImmutableDB — append-only finalized block storage.
 *
 * Block CBOR stored in BlobStore (LSM / IndexedDB), metadata in SQL.
 */
import { Context, Effect, Layer, Option, Stream } from "effect";
import type { StoredBlock, RealPoint } from "../types/StoredBlock.ts";
import { ImmutableDBError } from "../errors.ts";
import { BlobStore, PREFIX_BLK } from "../blob-store";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  writeImmutableBlock,
  writeImmutableBlocks,
  readImmutableBlock,
  getImmutableTip,
} from "../operations/blocks.ts";

export class ImmutableDB extends Context.Service<
  ImmutableDB,
  {
    readonly appendBlock: (block: StoredBlock) => Effect.Effect<void, ImmutableDBError>;
    /** Batch-append — 1 multi-VALUES INSERT round-trip instead of N. */
    readonly appendBlocks: (
      blocks: ReadonlyArray<StoredBlock>,
    ) => Effect.Effect<void, ImmutableDBError>;
    readonly readBlock: (
      point: RealPoint,
    ) => Effect.Effect<Option.Option<StoredBlock>, ImmutableDBError>;
    readonly getTip: Effect.Effect<Option.Option<RealPoint>, ImmutableDBError>;
    readonly streamBlocks: (
      fromSlot: bigint,
      toSlot: bigint,
    ) => Stream.Stream<StoredBlock, ImmutableDBError>;
  }
>()("storage/ImmutableDB") {}

export const ImmutableDBLive: Layer.Layer<ImmutableDB, never, BlobStore | SqlClient> = Layer.effect(
  ImmutableDB,
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const sql = yield* SqlClient;
    const provide = <A, E>(effect: Effect.Effect<A, E, BlobStore | SqlClient>) =>
      effect.pipe(Effect.provideService(BlobStore, store), Effect.provideService(SqlClient, sql));
    return {
      appendBlock: (block: StoredBlock) => provide(writeImmutableBlock(block)),
      appendBlocks: (blocks: ReadonlyArray<StoredBlock>) => provide(writeImmutableBlocks(blocks)),
      readBlock: (point: RealPoint) => provide(readImmutableBlock(point)),
      getTip: provide(getImmutableTip),
      streamBlocks: (fromSlot: bigint, toSlot: bigint) =>
        store.scan(PREFIX_BLK).pipe(
          Stream.takeWhile((entry) => {
            const view = new DataView(entry.key.buffer, entry.key.byteOffset);
            const slot = view.getBigUint64(4);
            return slot >= fromSlot && slot <= toSlot;
          }),
          Stream.mapEffect((entry) => {
            const view = new DataView(entry.key.buffer, entry.key.byteOffset);
            const slot = view.getBigUint64(4);
            const hash = entry.key.slice(12, 44);
            return provide(readImmutableBlock({ slot, hash }));
          }),
          Stream.filter(Option.isSome),
          Stream.map((opt) => opt.value),
          Stream.mapError((cause) => new ImmutableDBError({ operation: "streamBlocks", cause })),
        ),
    };
  }),
);
