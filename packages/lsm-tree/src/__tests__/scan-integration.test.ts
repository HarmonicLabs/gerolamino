/**
 * Integration test: populate LSM with UTxO-like data and scan it.
 * Simulates the bootstrap server's UTxO streaming pipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect, Stream } from "effect";
import { BlobStore, utxoKey, PREFIX_UTXO } from "storage";
import { layerLsm } from "../layer-lsm";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LIBLSM_BRIDGE_PATH = process.env["LIBLSM_BRIDGE_PATH"];
const skip = !LIBLSM_BRIDGE_PATH;

describe.skipIf(skip)("LSM scan integration (UTxO simulation)", () => {
  let tmpDir: string;

  const run = <A>(effect: Effect.Effect<A, unknown, BlobStore>) => {
    const layer = layerLsm(tmpDir);
    return Effect.runPromise(Effect.provide(effect, layer));
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsm-scan-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scans 1000 UTxO entries by prefix", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;

        // Insert 1000 UTxO entries
        const entries = Array.from({ length: 1000 }, (_, i) => {
          const txIn = new Uint8Array(34);
          new DataView(txIn.buffer).setUint32(0, i);
          return {
            key: utxoKey(txIn),
            value: new Uint8Array([i & 0xff, (i >> 8) & 0xff]),
          };
        });
        yield* store.putBatch(entries);

        // Also insert some non-UTxO entries
        yield* store.putBatch([
          {
            key: new Uint8Array([0x62, 0x6c, 0x6b, 0x3a, 0, 0, 0, 1]),
            value: new Uint8Array([99]),
          }, // blk: prefix
        ]);

        // Scan UTxO prefix — should get exactly 1000
        let count = 0;
        yield* Stream.runForEach(store.scan(PREFIX_UTXO), (_entry) =>
          Effect.sync(() => {
            count++;
          }),
        );
        return count;
      }),
    );
    expect(result).toBe(1000);
  });

  it("scan returns entries in sorted order", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;

        // Insert in reverse order
        const entries = [3, 1, 2].map((i) => {
          const txIn = new Uint8Array(34);
          txIn[0] = i;
          return { key: utxoKey(txIn), value: new Uint8Array([i]) };
        });
        yield* store.putBatch(entries);

        // Scan should return in sorted key order
        const values: number[] = [];
        yield* Stream.runForEach(store.scan(PREFIX_UTXO), (e) =>
          Effect.sync(() => {
            values.push(e.value[0]!);
          }),
        );
        return values;
      }),
    );
    expect(result).toEqual([1, 2, 3]);
  });

  it("batched scan simulates bootstrap stream", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;

        // Insert 2500 entries (will be batched into groups of 500)
        const entries = Array.from({ length: 2500 }, (_, i) => {
          const txIn = new Uint8Array(34);
          new DataView(txIn.buffer).setUint32(0, i);
          return { key: utxoKey(txIn), value: new Uint8Array(100).fill(i & 0xff) };
        });
        yield* store.putBatch(entries);

        // Simulate bootstrap stream batching
        let batchCount = 0;
        let totalEntries = 0;
        yield* store.scan(PREFIX_UTXO).pipe(
          Stream.grouped(500),
          Stream.runForEach((batch) =>
            Effect.sync(() => {
              batchCount++;
              totalEntries += batch.length;
            }),
          ),
        );
        return { batchCount, totalEntries };
      }),
    );
    expect(result.totalEntries).toBe(2500);
    expect(result.batchCount).toBe(5); // 2500 / 500 = 5 batches
  });
});
