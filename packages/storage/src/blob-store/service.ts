/**
 * BlobStore — abstract binary KV service with range scans and batch operations.
 *
 * Platform layers:
 *   - layerLsm: lsm-tree WASM via node:wasi (Bun TUI + bootstrap server)
 *   - layerIndexedDb: IndexedDB, LSM-based internally (Chrome extension)
 *
 * All storage logic uses `yield* BlobStore` — never imports a platform module.
 */
import { Effect, Schema, ServiceMap, Stream } from "effect";

export class BlobStoreError extends Schema.TaggedErrorClass<BlobStoreError>()(
  "BlobStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect,
  },
) {}

export interface BlobStoreShape {
  readonly get: (
    key: Uint8Array,
  ) => Effect.Effect<Uint8Array | undefined, BlobStoreError>;
  readonly put: (
    key: Uint8Array,
    value: Uint8Array,
  ) => Effect.Effect<void, BlobStoreError>;
  readonly delete: (
    key: Uint8Array,
  ) => Effect.Effect<void, BlobStoreError>;
  readonly has: (
    key: Uint8Array,
  ) => Effect.Effect<boolean, BlobStoreError>;
  /** Iterate all entries whose key starts with `prefix`, in lexicographic order. */
  readonly scan: (
    prefix: Uint8Array,
  ) => Stream.Stream<
    { readonly key: Uint8Array; readonly value: Uint8Array },
    BlobStoreError
  >;
  /** Atomically write multiple entries. */
  readonly putBatch: (
    entries: ReadonlyArray<{
      readonly key: Uint8Array;
      readonly value: Uint8Array;
    }>,
  ) => Effect.Effect<void, BlobStoreError>;
  /** Atomically delete multiple keys. */
  readonly deleteBatch: (
    keys: ReadonlyArray<Uint8Array>,
  ) => Effect.Effect<void, BlobStoreError>;
}

export class BlobStore extends ServiceMap.Service<BlobStore, BlobStoreShape>()(
  "storage/BlobStore",
) {}
