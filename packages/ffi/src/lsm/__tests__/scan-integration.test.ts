/**
 * Integration test: populate LSM with UTxO-like data and scan it.
 * Simulates the bootstrap server's UTxO streaming pipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { BlobStore } from "../../blob-store.ts";
import { utxoKey, PREFIX_UTXO } from "../../keys.ts";
import { layerLsm } from "../layer-lsm";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LIBLSM_BRIDGE_PATH = process.env["LIBLSM_BRIDGE_PATH"];
const skip = !LIBLSM_BRIDGE_PATH;

describe.skipIf(skip)("LSM scan integration (UTxO simulation)", () => {
  let tmpDir: string;

  const provide = <A>(effect: Effect.Effect<A, unknown, BlobStore>) =>
    effect.pipe(Effect.provide(layerLsm(tmpDir)));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsm-scan-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.effect("scans 1000 UTxO entries by prefix", () =>
    provide(
      Effect.gen(function* () {
        const store = yield* BlobStore;

        const entries = Array.from({ length: 1000 }, (_, i) => {
          const txIn = new Uint8Array(34);
          new DataView(txIn.buffer).setUint32(0, i);
          return {
            key: utxoKey(txIn),
            value: new Uint8Array([i & 0xff, (i >> 8) & 0xff]),
          };
        });
        yield* store.putBatch(entries);

        yield* store.putBatch([
          {
            key: new Uint8Array([0x62, 0x6c, 0x6b, 0x3a, 0, 0, 0, 1]),
            value: new Uint8Array([99]),
          },
        ]);

        let count = 0;
        yield* Stream.runForEach(store.scan(PREFIX_UTXO), (_entry) =>
          Effect.sync(() => {
            count++;
          }),
        );
        expect(count).toBe(1000);
      }),
    ),
  );

  it.effect("scan returns entries in sorted order", () =>
    provide(
      Effect.gen(function* () {
        const store = yield* BlobStore;

        const entries = [3, 1, 2].map((i) => {
          const txIn = new Uint8Array(34);
          txIn[0] = i;
          return { key: utxoKey(txIn), value: new Uint8Array([i]) };
        });
        yield* store.putBatch(entries);

        const values: number[] = [];
        yield* Stream.runForEach(store.scan(PREFIX_UTXO), (e) =>
          Effect.sync(() => {
            values.push(e.value[0]!);
          }),
        );
        expect(values).toEqual([1, 2, 3]);
      }),
    ),
  );

  it.effect("batched scan simulates bootstrap stream", () =>
    provide(
      Effect.gen(function* () {
        const store = yield* BlobStore;

        const entries = Array.from({ length: 2500 }, (_, i) => {
          const txIn = new Uint8Array(34);
          new DataView(txIn.buffer).setUint32(0, i);
          return { key: utxoKey(txIn), value: new Uint8Array(100).fill(i & 0xff) };
        });
        yield* store.putBatch(entries);

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
        expect(totalEntries).toBe(2500);
        expect(batchCount).toBe(5);
      }),
    ),
  );
});
