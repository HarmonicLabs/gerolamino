/**
 * BlobStore — abstract binary KV service with range scans and batch operations.
 *
 * Platform layers:
 *   - layerLsm: lsm-tree via native FFI (Bun TUI + bootstrap server)
 *   - layerIndexedDb: IndexedDB, LSM-based internally (Chrome extension)
 *
 * All storage logic uses `yield* BlobStore` — never imports a platform module.
 */
import { Context, Effect, Option, Schema, Stream } from "effect";

export class BlobStoreError extends Schema.TaggedErrorClass<BlobStoreError>()("BlobStoreError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly get: (key: Uint8Array) => Effect.Effect<Option.Option<Uint8Array>, BlobStoreError>;
    readonly put: (key: Uint8Array, value: Uint8Array) => Effect.Effect<void, BlobStoreError>;
    readonly delete: (key: Uint8Array) => Effect.Effect<void, BlobStoreError>;
    readonly has: (key: Uint8Array) => Effect.Effect<boolean, BlobStoreError>;
    readonly scan: (
      prefix: Uint8Array,
    ) => Stream.Stream<{ readonly key: Uint8Array; readonly value: Uint8Array }, BlobStoreError>;
    readonly putBatch: (
      entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>,
    ) => Effect.Effect<void, BlobStoreError>;
    readonly deleteBatch: (keys: ReadonlyArray<Uint8Array>) => Effect.Effect<void, BlobStoreError>;
  }
>()("storage/BlobStore") {}
