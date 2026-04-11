/**
 * In-memory BlobStore — backed by Effect's KeyValueStore.
 *
 * Uses KeyValueStore.layerMemory for get/put/delete/has.
 * Scan is implemented via a sorted key index maintained in a Ref.
 */
import { Effect, Layer, Option, Ref, Stream } from "effect";
import { KeyValueStore } from "effect/unstable/persistence/KeyValueStore";
import * as KV from "effect/unstable/persistence/KeyValueStore";
import { BlobStore, BlobStoreError } from "./service.ts";
import { prefixEnd } from "./keys.ts";

const toHex = (buf: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < buf.length; i++) s += buf[i]!.toString(16).padStart(2, "0");
  return s;
};

const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

const mapErr =
  (operation: string) =>
  <A>(effect: Effect.Effect<A, KV.KeyValueStoreError>) =>
    effect.pipe(Effect.mapError((cause) => new BlobStoreError({ operation, cause })));

/** BlobStore backed by KeyValueStore — requires KV layer to be provided. */
const layerKeyValueStore: Layer.Layer<BlobStore, never, KeyValueStore> = Layer.effect(
  BlobStore,
  Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    // Sorted key index for scan support (KVS has no iteration API)
    const keyIndex = yield* Ref.make(new Set<string>());

    return {
      get: (key: Uint8Array) =>
        kv.getUint8Array(toHex(key)).pipe(Effect.map(Option.fromNullishOr), mapErr("get")),

      put: (key: Uint8Array, value: Uint8Array) => {
        const h = toHex(key);
        return Effect.all([kv.set(h, value), Ref.update(keyIndex, (s) => new Set(s).add(h))], {
          discard: true,
        }).pipe(mapErr("put"));
      },

      delete: (key: Uint8Array) => {
        const h = toHex(key);
        return Effect.all(
          [
            kv.remove(h),
            Ref.update(keyIndex, (s) => {
              const next = new Set(s);
              next.delete(h);
              return next;
            }),
          ],
          { discard: true },
        ).pipe(mapErr("delete"));
      },

      has: (key: Uint8Array) => kv.has(toHex(key)).pipe(mapErr("has")),

      scan: (prefix: Uint8Array) => {
        const lo = toHex(prefix);
        const hi = toHex(prefixEnd(prefix));
        return Stream.fromEffect(Ref.get(keyIndex)).pipe(
          Stream.flatMap((ks) =>
            Stream.fromIterable([...ks].filter((k) => k >= lo && (hi === "" || k < hi)).sort()),
          ),
          Stream.mapEffect((h) =>
            kv.getUint8Array(h).pipe(
              Effect.map((v) => ({ key: fromHex(h), value: v ?? new Uint8Array(0) })),
              mapErr("scan"),
            ),
          ),
        );
      },

      putBatch: (
        entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>,
      ) => {
        const hexEntries = entries.map((e) => ({ h: toHex(e.key), value: e.value }));
        return Effect.all(
          [
            Effect.forEach(hexEntries, ({ h, value }) => kv.set(h, value), { discard: true }),
            Ref.update(keyIndex, (s) => {
              const next = new Set(s);
              for (const { h } of hexEntries) next.add(h);
              return next;
            }),
          ],
          { discard: true },
        ).pipe(mapErr("putBatch"));
      },

      deleteBatch: (keys: ReadonlyArray<Uint8Array>) => {
        const hexKeys = keys.map(toHex);
        return Effect.all(
          [
            Effect.forEach(hexKeys, (h) => kv.remove(h), { discard: true }),
            Ref.update(keyIndex, (s) => {
              const next = new Set(s);
              for (const h of hexKeys) next.delete(h);
              return next;
            }),
          ],
          { discard: true },
        ).pipe(mapErr("deleteBatch"));
      },
    };
  }),
);

/** In-memory BlobStore — no external dependencies. */
export const layerInMemory: Layer.Layer<BlobStore> = layerKeyValueStore.pipe(
  Layer.provide(KV.layerMemory),
);
