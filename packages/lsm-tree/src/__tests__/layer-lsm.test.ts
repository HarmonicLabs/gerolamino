/**
 * Integration tests for the LSM BlobStore layer.
 *
 * Requires LIBLSM_PATH env var pointing to liblsm-ffi.so.
 * Skip with: LIBLSM_PATH="" bunx --bun vitest
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect, Exit, Stream } from "effect";
import { BlobStore } from "../../../storage/src/blob-store/service";
import { layerLsm } from "../layer-lsm";
import { utxoKey } from "../../../storage/src/blob-store/keys";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LIBLSM_PATH = process.env["LIBLSM_PATH"];
const skip = !LIBLSM_PATH;

describe.skipIf(skip)("BlobStore LSM layer", () => {
  let tmpDir: string;

  const run = <A>(effect: Effect.Effect<A, unknown, BlobStore>) => {
    const layer = layerLsm(LIBLSM_PATH!, tmpDir);
    return Effect.runPromise(Effect.provide(effect, layer));
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsm-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("put and get a single entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const key = new Uint8Array([1, 2, 3, 4]);
        const value = new Uint8Array([10, 20, 30]);
        yield* store.put(key, value);
        return yield* store.get(key);
      }),
    );
    expect(result).toEqual(new Uint8Array([10, 20, 30]));
  });

  it("get returns undefined for missing key", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        return yield* store.get(new Uint8Array([99, 99]));
      }),
    );
    expect(result).toBeUndefined();
  });

  it("has returns true for existing key", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const key = new Uint8Array([5, 6, 7]);
        yield* store.put(key, new Uint8Array([1]));
        return yield* store.has(key);
      }),
    );
    expect(result).toBe(true);
  });

  it("has returns false for missing key", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        return yield* store.has(new Uint8Array([99]));
      }),
    );
    expect(result).toBe(false);
  });

  it("delete removes a key", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const key = new Uint8Array([8, 9]);
        yield* store.put(key, new Uint8Array([1]));
        yield* store.delete(key);
        return yield* store.has(key);
      }),
    );
    expect(result).toBe(false);
  });

  it("putBatch writes multiple entries atomically", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* store.putBatch([
          { key: new Uint8Array([1]), value: new Uint8Array([10]) },
          { key: new Uint8Array([2]), value: new Uint8Array([20]) },
          { key: new Uint8Array([3]), value: new Uint8Array([30]) },
        ]);
        const v1 = yield* store.get(new Uint8Array([1]));
        const v2 = yield* store.get(new Uint8Array([2]));
        const v3 = yield* store.get(new Uint8Array([3]));
        return [v1, v2, v3];
      }),
    );
    expect(result).toEqual([
      new Uint8Array([10]),
      new Uint8Array([20]),
      new Uint8Array([30]),
    ]);
  });

  it("deleteBatch removes multiple keys", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* store.putBatch([
          { key: new Uint8Array([1]), value: new Uint8Array([10]) },
          { key: new Uint8Array([2]), value: new Uint8Array([20]) },
        ]);
        yield* store.deleteBatch([new Uint8Array([1]), new Uint8Array([2])]);
        const h1 = yield* store.has(new Uint8Array([1]));
        const h2 = yield* store.has(new Uint8Array([2]));
        return [h1, h2];
      }),
    );
    expect(result).toEqual([false, false]);
  });

  it("handles prefix keys correctly", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const txIn = new Uint8Array(34); // 32B txId + 2B index
        txIn[0] = 0xaa;
        const key = utxoKey(txIn);
        const value = new Uint8Array([0xbb, 0xcc]);
        yield* store.put(key, value);
        return yield* store.get(key);
      }),
    );
    expect(result).toEqual(new Uint8Array([0xbb, 0xcc]));
  });

  it("scan returns entries matching prefix", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        // Insert entries with different prefixes
        yield* store.putBatch([
          { key: new Uint8Array([0x01, 0x00]), value: new Uint8Array([10]) },
          { key: new Uint8Array([0x01, 0x01]), value: new Uint8Array([11]) },
          { key: new Uint8Array([0x01, 0x02]), value: new Uint8Array([12]) },
          { key: new Uint8Array([0x02, 0x00]), value: new Uint8Array([20]) },
        ]);
        // Scan for prefix 0x01
        const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
        yield* Stream.runForEach(
          store.scan(new Uint8Array([0x01])),
          (e) => Effect.sync(() => { entries.push(e); }),
        );
        return entries.length;
      }),
    );
    expect(result).toBe(3);
  });

  it("handles large values", async () => {
    const largeValue = new Uint8Array(1024 * 100); // 100KB
    for (let i = 0; i < largeValue.length; i++) largeValue[i] = i & 0xff;

    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const key = new Uint8Array([42]);
        yield* store.put(key, largeValue);
        return yield* store.get(key);
      }),
    );
    expect(result).toEqual(largeValue);
  });
});
