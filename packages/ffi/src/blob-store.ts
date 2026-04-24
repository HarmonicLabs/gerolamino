/**
 * BlobStore — abstract binary KV service with range scans and batch operations.
 *
 * Lives in `ffi` because the LSM FFI backend is the source-of-truth
 * implementation. `storage` consumers import via `ffi` or via `storage`'s
 * thin re-export (`storage/src/blob-store/service.ts`).
 *
 * Platform layers:
 *   - layerLsm / layerLsmFromSnapshot: V2LSM via native FFI (Bun TUI + bootstrap)
 *   - layerInMemory (in `storage`): Effect KeyValueStore backing, for tests
 *   - layerIndexedDb (future): IndexedDB, LSM-based internally (Chrome ext)
 *
 * All storage logic uses `yield* BlobStore` — never imports a platform module.
 */
import { Context, Effect, Option, Schema, Stream } from "effect";

export const BlobStoreOperation = Schema.Literals([
  "get",
  "put",
  "delete",
  "has",
  "scan",
  "putBatch",
  "deleteBatch",
  "lsm",
]);
export type BlobStoreOperation = typeof BlobStoreOperation.Type;

export class BlobStoreError extends Schema.TaggedErrorClass<BlobStoreError>()("BlobStoreError", {
  operation: BlobStoreOperation,
  cause: Schema.Defect,
}) {}

export const BlobEntry = Schema.Struct({
  key: Schema.Uint8Array,
  value: Schema.Uint8Array,
});
export type BlobEntry = typeof BlobEntry.Type;

export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly get: (key: Uint8Array) => Effect.Effect<Option.Option<Uint8Array>, BlobStoreError>;
    readonly put: (key: Uint8Array, value: Uint8Array) => Effect.Effect<void, BlobStoreError>;
    readonly delete: (key: Uint8Array) => Effect.Effect<void, BlobStoreError>;
    readonly has: (key: Uint8Array) => Effect.Effect<boolean, BlobStoreError>;
    readonly scan: (prefix: Uint8Array) => Stream.Stream<BlobEntry, BlobStoreError>;
    readonly putBatch: (entries: ReadonlyArray<BlobEntry>) => Effect.Effect<void, BlobStoreError>;
    readonly deleteBatch: (keys: ReadonlyArray<Uint8Array>) => Effect.Effect<void, BlobStoreError>;
  }
>()("ffi/BlobStore") {}
