/**
 * In-memory BlobStore — for testing and sync-from-genesis without FFI.
 *
 * Stores entries in a sorted Map keyed by hex-encoded Uint8Array.
 * Provides all BlobStore operations backed by plain JS data structures.
 */
import { Effect, Layer, Stream } from "effect";
import { BlobStore, BlobStoreError } from "./service.ts";
import { prefixEnd } from "./keys.ts";

const toHex = (buf: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i]!.toString(16).padStart(2, "0");
  return s;
};

const fail = (operation: string, cause: unknown) =>
  new BlobStoreError({ operation, cause });

export const layerInMemory: Layer.Layer<BlobStore> = Layer.succeed(
  BlobStore,
  (() => {
    const data = new Map<string, { key: Uint8Array; value: Uint8Array }>();

    return {
      get: (key: Uint8Array) =>
        Effect.try({
          try: () => data.get(toHex(key))?.value,
          catch: (cause) => fail("get", cause),
        }),

      put: (key: Uint8Array, value: Uint8Array) =>
        Effect.try({
          try: () => { data.set(toHex(key), { key, value }); },
          catch: (cause) => fail("put", cause),
        }),

      delete: (key: Uint8Array) =>
        Effect.try({
          try: () => { data.delete(toHex(key)); },
          catch: (cause) => fail("delete", cause),
        }),

      has: (key: Uint8Array) =>
        Effect.try({
          try: () => data.has(toHex(key)),
          catch: (cause) => fail("has", cause),
        }),

      scan: (prefix: Uint8Array) => {
        const lo = toHex(prefix);
        const hi = toHex(prefixEnd(prefix));
        return Stream.fromIterable(
          [...data.entries()]
            .filter(([k]) => k >= lo && (hi === "" || k < hi))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([, entry]) => entry),
        );
      },

      putBatch: (entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>) =>
        Effect.try({
          try: () => { for (const e of entries) data.set(toHex(e.key), { key: e.key, value: e.value }); },
          catch: (cause) => fail("putBatch", cause),
        }),

      deleteBatch: (keys: ReadonlyArray<Uint8Array>) =>
        Effect.try({
          try: () => { for (const k of keys) data.delete(toHex(k)); },
          catch: (cause) => fail("deleteBatch", cause),
        }),
    };
  })(),
);
