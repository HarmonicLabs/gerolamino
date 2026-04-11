/**
 * VolatileDB — fork-aware storage for recent (not yet finalized) blocks.
 *
 * Block CBOR stored in BlobStore, metadata in SQL.
 */
import { Effect, Layer, Option, ServiceMap } from "effect";
import type { StoredBlock } from "../types/StoredBlock.ts";
import { VolatileDBError } from "../errors.ts";
import { BlobStore } from "../blob-store";
import { SqliteDrizzle } from "../db";
import {
  writeVolatileBlock,
  readVolatileBlock,
  getVolatileSuccessors,
  garbageCollectVolatile,
} from "../operations/blocks.ts";

export class VolatileDB extends ServiceMap.Service<
  VolatileDB,
  {
    readonly addBlock: (block: StoredBlock) => Effect.Effect<void, VolatileDBError>;
    readonly getBlock: (hash: Uint8Array) => Effect.Effect<Option.Option<StoredBlock>, VolatileDBError>;
    readonly getSuccessors: (hash: Uint8Array) => Effect.Effect<ReadonlyArray<Uint8Array>, VolatileDBError>;
    readonly garbageCollect: (belowSlot: number) => Effect.Effect<void, VolatileDBError>;
  }
>()("storage/VolatileDB") {}

export const VolatileDBLive: Layer.Layer<VolatileDB, never, BlobStore | SqliteDrizzle> =
  Layer.effect(
    VolatileDB,
    Effect.gen(function* () {
      const store = yield* BlobStore;
      const drizzle = yield* SqliteDrizzle;
      const provide = <A, E>(effect: Effect.Effect<A, E, BlobStore | SqliteDrizzle>) =>
        effect.pipe(
          Effect.provideService(BlobStore, store),
          Effect.provideService(SqliteDrizzle, drizzle),
        );
      return {
        addBlock: (block: StoredBlock) => provide(writeVolatileBlock(block)),
        getBlock: (hash: Uint8Array) => provide(readVolatileBlock(hash)),
        getSuccessors: (hash: Uint8Array) => provide(getVolatileSuccessors(hash)),
        garbageCollect: (belowSlot: number) => provide(garbageCollectVolatile(belowSlot)),
      };
    }),
  );
