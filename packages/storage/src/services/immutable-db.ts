/**
 * ImmutableDB — append-only finalized block storage.
 *
 * Block CBOR stored in BlobStore (LSM / IndexedDB), metadata in SQL.
 */
import { Effect, Layer, Stream, ServiceMap } from "effect";
import type { StoredBlock, RealPoint } from "../types/StoredBlock.ts";
import { ImmutableDBError } from "../errors.ts";
import { BlobStore } from "../blob-store/service.ts";
import { PREFIX_BLK } from "../blob-store/keys.ts";
import {
  writeImmutableBlock,
  readImmutableBlock,
  getImmutableTip,
} from "../operations/blocks.ts";

export class ImmutableDB extends ServiceMap.Service<
  ImmutableDB,
  {
    readonly appendBlock: (block: StoredBlock) => Effect.Effect<void, ImmutableDBError>;
    readonly readBlock: (point: RealPoint) => Effect.Effect<StoredBlock | undefined, ImmutableDBError>;
    readonly getTip: Effect.Effect<RealPoint | undefined, ImmutableDBError>;
    readonly streamBlocks: (
      fromSlot: bigint,
      toSlot: bigint,
    ) => Stream.Stream<StoredBlock, ImmutableDBError>;
  }
>()("storage/ImmutableDB") {}

export const ImmutableDBLive: Layer.Layer<ImmutableDB, never, BlobStore> = Layer.effect(
  ImmutableDB,
  Effect.gen(function* () {
    const store = yield* BlobStore;
    return {
      appendBlock: (block: StoredBlock) => writeImmutableBlock(block),
      readBlock: (point: RealPoint) => readImmutableBlock(point),
      getTip: getImmutableTip,
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
            return readImmutableBlock({ slot, hash });
          }),
          Stream.filter((block): block is StoredBlock => block !== undefined),
          Stream.mapError((cause) => new ImmutableDBError({ operation: "streamBlocks", cause })),
        ),
    };
  }),
);
