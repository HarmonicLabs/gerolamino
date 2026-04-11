/**
 * ImmutableDB — append-only finalized block storage.
 *
 * Block CBOR stored in BlobStore (LSM / IndexedDB), metadata in SQL.
 */
import { Effect, Layer, Option, Stream, ServiceMap } from "effect";
import type { StoredBlock, RealPoint } from "../types/StoredBlock.ts";
import { ImmutableDBError } from "../errors.ts";
import { BlobStore, PREFIX_BLK } from "../blob-store";
import { SqliteDrizzle } from "../db";
import { writeImmutableBlock, readImmutableBlock, getImmutableTip } from "../operations/blocks.ts";

export class ImmutableDB extends ServiceMap.Service<
  ImmutableDB,
  {
    readonly appendBlock: (block: StoredBlock) => Effect.Effect<void, ImmutableDBError>;
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

export const ImmutableDBLive: Layer.Layer<ImmutableDB, never, BlobStore | SqliteDrizzle> =
  Layer.effect(
    ImmutableDB,
    Effect.gen(function* () {
      const store = yield* BlobStore;
      const drizzle = yield* SqliteDrizzle;
      const provide = <A, E>(effect: Effect.Effect<A, E, BlobStore | SqliteDrizzle>) =>
        effect.pipe(
          Effect.provideService(BlobStore, store),
          Effect.provideService(SqliteDrizzle, drizzle),
        );
      return {
        appendBlock: (block: StoredBlock) => provide(writeImmutableBlock(block)),
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
