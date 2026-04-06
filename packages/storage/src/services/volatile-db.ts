/**
 * VolatileDB — fork-aware storage for recent (not yet finalized) blocks.
 *
 * Block CBOR stored in BlobStore, metadata in SQL.
 */
import { Effect, Layer, ServiceMap } from "effect";
import type { StoredBlock } from "../types/StoredBlock.ts";
import { VolatileDBError } from "../errors.ts";
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
    readonly getBlock: (hash: Uint8Array) => Effect.Effect<StoredBlock | undefined, VolatileDBError>;
    readonly getSuccessors: (hash: Uint8Array) => Effect.Effect<ReadonlyArray<Uint8Array>, VolatileDBError>;
    readonly garbageCollect: (belowSlot: number) => Effect.Effect<void, VolatileDBError>;
  }
>()("storage/VolatileDB") {}

export const VolatileDBLive: Layer.Layer<VolatileDB> = Layer.succeed(VolatileDB, {
  addBlock: (block: StoredBlock) => writeVolatileBlock(block),
  getBlock: (hash: Uint8Array) => readVolatileBlock(hash),
  getSuccessors: (hash: Uint8Array) => getVolatileSuccessors(hash),
  garbageCollect: (belowSlot: number) => garbageCollectVolatile(belowSlot),
});
