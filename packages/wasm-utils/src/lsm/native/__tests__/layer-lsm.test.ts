/**
 * Integration tests for the LSM BlobStore layer via Zig bridge.
 *
 * Requires LIBLSM_BRIDGE_PATH env var pointing to liblsm-bridge.so.
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { BlobStore } from "../../blob-store.ts";
import { utxoKey } from "../../keys.ts";
import { layerLsm } from "../layer-lsm";

const LIBLSM_BRIDGE_PATH = process.env["LIBLSM_BRIDGE_PATH"];
const skip = !LIBLSM_BRIDGE_PATH;

const TestPlatformLayer = Layer.mergeAll(BunFileSystem.layer, Path.layer);

const acquireTempDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "lsm-test-" }),
);

const withLsm = <A, E, R>(body: Effect.Effect<A, E, R | BlobStore>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const tmpDir = yield* acquireTempDir;
      return yield* body.pipe(Effect.provide(layerLsm(tmpDir)));
    }),
  ).pipe(Effect.provide(TestPlatformLayer));

describe.skipIf(skip)("BlobStore LSM layer", () => {
  it.effect("put and get a single entry", () =>
    withLsm(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const key = new Uint8Array([1, 2, 3, 4]);
        const value = new Uint8Array([10, 20, 30]);
        yield* store.put(key, value);
        const result = Option.getOrUndefined(yield* store.get(key));
        expect(result).toEqual(new Uint8Array([10, 20, 30]));
      }),
    ),
  );

  it.effect("get returns undefined for missing key", () =>
    withLsm(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const result = Option.getOrUndefined(yield* store.get(new Uint8Array([99, 99])));
        expect(result).toBeUndefined();
      }),
    ),
  );

  it.effect("has returns true for existing key", () =>
    withLsm(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const key = new Uint8Array([5, 6, 7]);
        yield* store.put(key, new Uint8Array([1]));
        const result = yield* store.has(key);
        expect(result).toBe(true);
      }),
    ),
  );

  it.effect("has returns false for missing key", () =>
    withLsm(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const result = yield* store.has(new Uint8Array([99]));
        expect(result).toBe(false);
      }),
    ),
  );

  it.effect("delete removes a key", () =>
    withLsm(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const key = new Uint8Array([8, 9]);
        yield* store.put(key, new Uint8Array([1]));
        yield* store.delete(key);
        const result = yield* store.has(key);
        expect(result).toBe(false);
      }),
    ),
  );

  it.effect("putBatch writes multiple entries", () =>
    withLsm(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* store.putBatch([
          { key: new Uint8Array([1]), value: new Uint8Array([10]) },
          { key: new Uint8Array([2]), value: new Uint8Array([20]) },
          { key: new Uint8Array([3]), value: new Uint8Array([30]) },
        ]);
        const v1 = Option.getOrUndefined(yield* store.get(new Uint8Array([1])));
        const v2 = Option.getOrUndefined(yield* store.get(new Uint8Array([2])));
        const v3 = Option.getOrUndefined(yield* store.get(new Uint8Array([3])));
        expect([v1, v2, v3]).toEqual([
          new Uint8Array([10]),
          new Uint8Array([20]),
          new Uint8Array([30]),
        ]);
      }),
    ),
  );

  it.effect("deleteBatch removes multiple keys", () =>
    withLsm(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* store.putBatch([
          { key: new Uint8Array([1]), value: new Uint8Array([10]) },
          { key: new Uint8Array([2]), value: new Uint8Array([20]) },
        ]);
        yield* store.deleteBatch([new Uint8Array([1]), new Uint8Array([2])]);
        const h1 = yield* store.has(new Uint8Array([1]));
        const h2 = yield* store.has(new Uint8Array([2]));
        expect([h1, h2]).toEqual([false, false]);
      }),
    ),
  );

  it.effect("handles prefix keys correctly", () =>
    withLsm(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const txIn = new Uint8Array(34);
        txIn[0] = 0xaa;
        const key = utxoKey(txIn);
        const value = new Uint8Array([0xbb, 0xcc]);
        yield* store.put(key, value);
        const result = Option.getOrUndefined(yield* store.get(key));
        expect(result).toEqual(new Uint8Array([0xbb, 0xcc]));
      }),
    ),
  );

  it.effect("handles large values", () => {
    const largeValue = new Uint8Array(1024 * 100);
    for (let i = 0; i < largeValue.length; i++) largeValue[i] = i & 0xff;

    return withLsm(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const key = new Uint8Array([42]);
        yield* store.put(key, largeValue);
        const result = Option.getOrUndefined(yield* store.get(key));
        expect(result).toEqual(largeValue);
      }),
    );
  });
});
