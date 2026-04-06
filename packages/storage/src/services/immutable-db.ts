/**
 * ImmutableDB — append-only finalized block storage.
 *
 * Block CBOR stored in BlobStore (LSM / IndexedDB), metadata in SQL.
 * Blocks are immutable once written — only appended, never modified.
 */
import { Effect, Stream, ServiceMap } from "effect";
import type { StoredBlock, RealPoint } from "../types/StoredBlock.ts";
import { ImmutableDBError } from "../errors.ts";
import { BlobStore } from "../blob-store/service.ts";
import { blockKey, PREFIX_BLK, prefixEnd } from "../blob-store/keys.ts";
import {
  writeImmutableBlock,
  readImmutableBlock,
  getImmutableTip,
} from "../operations/blocks.ts";

export interface ImmutableDBShape {
  /** Append a finalized block. */
  readonly appendBlock: (
    block: StoredBlock,
  ) => Effect.Effect<void, ImmutableDBError>;

  /** Read a block by slot + hash. */
  readonly readBlock: (
    point: RealPoint,
  ) => Effect.Effect<StoredBlock | undefined, ImmutableDBError>;

  /** Get the tip (highest slot). */
  readonly getTip: Effect.Effect<RealPoint | undefined, ImmutableDBError>;

  /** Stream blocks in slot order within a range. */
  readonly streamBlocks: (
    fromSlot: bigint,
    toSlot: bigint,
  ) => Stream.Stream<StoredBlock, ImmutableDBError>;
}

export class ImmutableDB extends ServiceMap.Service<ImmutableDB, ImmutableDBShape>()(
  "storage/ImmutableDB",
) {}

/** Default ImmutableDB layer — requires SqliteDrizzle + BlobStore in environment. */
export const ImmutableDBLive = Effect.gen(function* () {
  const store = yield* BlobStore;

  return {
    appendBlock: (block) => writeImmutableBlock(block),

    readBlock: (point) => readImmutableBlock(point),

    getTip: getImmutableTip,

    streamBlocks: (fromSlot, toSlot) => {
      const fromKey = blockKey(fromSlot, new Uint8Array(32));
      const toKey = blockKey(toSlot + 1n, new Uint8Array(32));
      return store.scan(PREFIX_BLK).pipe(
        Stream.takeWhile((entry) => {
          // Compare key bytes — slot is at offset 4 (after "blk:" prefix), 8 bytes BE
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
      );
    },
  } satisfies ImmutableDBShape;
});
