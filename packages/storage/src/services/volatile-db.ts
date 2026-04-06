/**
 * VolatileDB — fork-aware storage for recent (not yet finalized) blocks.
 *
 * Block CBOR stored in BlobStore, metadata in SQL.
 * Supports multiple forks via hash-based keying + successor index.
 */
import { Effect, ServiceMap } from "effect";
import type { StoredBlock } from "../types/StoredBlock.ts";
import { VolatileDBError } from "../errors.ts";
import {
  writeVolatileBlock,
  readVolatileBlock,
  getVolatileSuccessors,
  garbageCollectVolatile,
} from "../operations/blocks.ts";

export interface VolatileDBShape {
  /** Add a block (may be on any fork). */
  readonly addBlock: (
    block: StoredBlock,
  ) => Effect.Effect<void, VolatileDBError>;

  /** Get a block by header hash. */
  readonly getBlock: (
    hash: Uint8Array,
  ) => Effect.Effect<StoredBlock | undefined, VolatileDBError>;

  /** Get all blocks whose prevHash equals the given hash. */
  readonly getSuccessors: (
    hash: Uint8Array,
  ) => Effect.Effect<ReadonlyArray<Uint8Array>, VolatileDBError>;

  /** Remove all blocks with slot < belowSlot. */
  readonly garbageCollect: (
    belowSlot: number,
  ) => Effect.Effect<void, VolatileDBError>;
}

export class VolatileDB extends ServiceMap.Service<VolatileDB, VolatileDBShape>()(
  "storage/VolatileDB",
) {}

/** Default VolatileDB implementation — requires SqliteDrizzle + BlobStore. */
export const VolatileDBLive = Effect.succeed({
  addBlock: (block) => writeVolatileBlock(block),
  getBlock: (hash) => readVolatileBlock(hash),
  getSuccessors: (hash) => getVolatileSuccessors(hash),
  garbageCollect: (belowSlot) => garbageCollectVolatile(belowSlot),
} satisfies VolatileDBShape);
