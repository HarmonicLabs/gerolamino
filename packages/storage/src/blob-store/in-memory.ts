/**
 * In-memory BlobStore — for testing and sync-from-genesis without FFI.
 *
 * Stores entries in a Ref<Map> keyed by hex-encoded Uint8Array.
 * Provides all BlobStore operations backed by Effect's Ref for
 * atomic state management.
 */
import { Effect, Layer, Ref, Stream } from "effect";
import { BlobStore, BlobStoreError } from "./service.ts";
import { prefixEnd } from "./keys.ts";

const toHex = (buf: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i]!.toString(16).padStart(2, "0");
  return s;
};

const fail = (operation: string, cause: unknown) =>
  new BlobStoreError({ operation, cause });

export const layerInMemory: Layer.Layer<BlobStore> = Layer.effect(
  BlobStore,
  Effect.gen(function* () {
    const data = yield* Ref.make(new Map<string, { key: Uint8Array; value: Uint8Array }>());

    return {
      get: (key: Uint8Array) =>
        Ref.get(data).pipe(
          Effect.map((m) => m.get(toHex(key))?.value),
          Effect.mapError((cause) => fail("get", cause)),
        ),

      put: (key: Uint8Array, value: Uint8Array) =>
        Ref.update(data, (m) => {
          const next = new Map(m);
          next.set(toHex(key), { key, value });
          return next;
        }).pipe(Effect.mapError((cause) => fail("put", cause))),

      delete: (key: Uint8Array) =>
        Ref.update(data, (m) => {
          const next = new Map(m);
          next.delete(toHex(key));
          return next;
        }).pipe(Effect.mapError((cause) => fail("delete", cause))),

      has: (key: Uint8Array) =>
        Ref.get(data).pipe(
          Effect.map((m) => m.has(toHex(key))),
          Effect.mapError((cause) => fail("has", cause)),
        ),

      scan: (prefix: Uint8Array) => {
        const lo = toHex(prefix);
        const hi = toHex(prefixEnd(prefix));
        return Stream.fromEffect(Ref.get(data)).pipe(
          Stream.flatMap((m) =>
            Stream.fromIterable(
              [...m.entries()]
                .filter(([k]) => k >= lo && (hi === "" || k < hi))
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([, entry]) => entry),
            ),
          ),
        );
      },

      putBatch: (entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>) =>
        Ref.update(data, (m) => {
          const next = new Map(m);
          for (const e of entries) next.set(toHex(e.key), { key: e.key, value: e.value });
          return next;
        }).pipe(Effect.mapError((cause) => fail("putBatch", cause))),

      deleteBatch: (keys: ReadonlyArray<Uint8Array>) =>
        Ref.update(data, (m) => {
          const next = new Map(m);
          for (const k of keys) next.delete(toHex(k));
          return next;
        }).pipe(Effect.mapError((cause) => fail("deleteBatch", cause))),
    };
  }),
);
