/**
 * ChainDB — unified chain storage service.
 *
 * Abstracts over ImmutableDB + VolatileDB + LedgerDB into a single service
 * that the consensus layer interacts with. All operations go through
 * BlobStore (for blobs) and SqlClient (for metadata).
 *
 * Design principles (per user directive):
 *   - Abstract service interface — implementation details left open-ended
 *   - No naive JS Maps — all state in BlobStore or SQL
 *   - Volatile-first lookups (spec 12.1.1)
 *   - Fork-aware iterators
 *   - Rollback support up to k blocks
 *
 * The service shape is intentionally broad — layers can implement
 * subsets (e.g., read-only for bootstrap, full for sync).
 */
import { Context, Effect, Option, Schema, Stream } from "effect";
import type { BlobEntry } from "../blob-store/service.ts";
import type { StoredBlock, RealPoint } from "../types/StoredBlock.ts";

export class ChainDBError extends Schema.TaggedErrorClass<ChainDBError>()("ChainDBError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

/** Result of a chain update — used by followers. */
export type ChainUpdate =
  | { readonly _tag: "AddBlock"; readonly block: StoredBlock }
  | { readonly _tag: "RollBack"; readonly point: RealPoint };

export class ChainDB extends Context.Service<
  ChainDB,
  {
    // --- Block lookups (volatile-first, then immutable) ---

    /** Get block by hash. Tries volatile first, then immutable. */
    readonly getBlock: (
      hash: Uint8Array,
    ) => Effect.Effect<Option.Option<StoredBlock>, ChainDBError>;

    /** Get block by slot + hash (exact point). */
    readonly getBlockAt: (
      point: RealPoint,
    ) => Effect.Effect<Option.Option<StoredBlock>, ChainDBError>;

    // --- Chain tip ---

    /** Current chain tip (most recent block). */
    readonly getTip: Effect.Effect<Option.Option<RealPoint>, ChainDBError>;

    /** Immutable tip (k blocks behind chain tip — blocks before this are final). */
    readonly getImmutableTip: Effect.Effect<Option.Option<RealPoint>, ChainDBError>;

    // --- Block writing ---

    /** Add a new block to the volatile chain. Also writes block_index + CBOR offset entries. */
    readonly addBlock: (block: StoredBlock) => Effect.Effect<void, ChainDBError>;

    /** Write arbitrary prefixed blob entries (block_index, offsets, utxo, etc.) in batch. */
    readonly writeBlobEntries: (
      entries: ReadonlyArray<BlobEntry>,
    ) => Effect.Effect<void, ChainDBError>;

    /** Delete arbitrary prefixed blob entries (consumed UTxO inputs, deregistered accounts). */
    readonly deleteBlobEntries: (
      keys: ReadonlyArray<Uint8Array>,
    ) => Effect.Effect<void, ChainDBError>;

    // --- Fork handling ---

    /** Rollback to a given point. Removes all blocks after this point from volatile state. */
    readonly rollback: (point: RealPoint) => Effect.Effect<void, ChainDBError>;

    /** Get all successor hashes of a block (for fork traversal). */
    readonly getSuccessors: (
      hash: Uint8Array,
    ) => Effect.Effect<ReadonlyArray<Uint8Array>, ChainDBError>;

    // --- Iterators ---

    /** Stream blocks in slot order from a point to tip. Crosses immutable/volatile boundary. */
    readonly streamFrom: (from: RealPoint) => Stream.Stream<StoredBlock, ChainDBError>;

    // --- Immutable promotion ---

    /** Promote volatile blocks up to the given point to immutable. */
    readonly promoteToImmutable: (upTo: RealPoint) => Effect.Effect<void, ChainDBError>;

    // --- Garbage collection ---

    /** Remove volatile blocks older than the given slot. */
    readonly garbageCollect: (belowSlot: bigint) => Effect.Effect<void, ChainDBError>;

    // --- Ledger state ---

    /** Write a ledger state snapshot. */
    readonly writeLedgerSnapshot: (
      slot: bigint,
      hash: Uint8Array,
      epoch: bigint,
      stateBytes: Uint8Array,
    ) => Effect.Effect<void, ChainDBError>;

    /** Read the latest ledger state snapshot. */
    readonly readLatestLedgerSnapshot: Effect.Effect<
      Option.Option<{ point: RealPoint; stateBytes: Uint8Array; epoch: bigint }>,
      ChainDBError
    >;

    // --- Nonce persistence ---

    /** Write nonces for a given epoch. Upserts on conflict. */
    readonly writeNonces: (
      epoch: bigint,
      active: Uint8Array,
      evolving: Uint8Array,
      candidate: Uint8Array,
    ) => Effect.Effect<void, ChainDBError>;

    /** Read the most recent persisted nonces. */
    readonly readNonces: Effect.Effect<
      Option.Option<{
        epoch: bigint;
        active: Uint8Array;
        evolving: Uint8Array;
        candidate: Uint8Array;
      }>,
      ChainDBError
    >;
  }
>()("storage/ChainDB") {}
