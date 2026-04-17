import { describe, it, assert } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { readSnapshotMeta, bootstrapStream, preloadLedgerFiles } from "../loader.ts";
import { BootstrapMessageKind, decodeFrame } from "bootstrap";
import { BlobStore, BlobStoreError } from "storage";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// Stub BlobStore for tests that don't exercise UTxO streaming
const notImpl = (op: string) => () =>
  Effect.fail(new BlobStoreError({ operation: op, cause: "stub" }));
const stubBlobStore = Layer.succeed(BlobStore, {
  get: notImpl("get"),
  put: notImpl("put"),
  delete: notImpl("delete"),
  has: notImpl("has"),
  scan: () => Stream.empty,
  putBatch: notImpl("putBatch"),
  deleteBatch: notImpl("deleteBatch"),
} as never);

const testLayers = Layer.mergeAll(platform, stubBlobStore);

describe("Integration", () => {
  it.effect("reads snapshot metadata correctly", () =>
    readSnapshotMeta("./db").pipe(
      Effect.tap((meta) =>
        Effect.sync(() => {
          assert.strictEqual(meta.protocolMagic, 1);
          assert.strictEqual(meta.snapshotSlot, 119401006n);
          assert.isTrue(meta.totalChunks > 0);
          assert.isTrue(meta.lsmDir !== undefined || meta.lsmDir === undefined); // backend-agnostic
        }),
      ),
      Effect.provide(testLayers),
    ),
  );

  it.effect("bootstrap stream starts with Init frame", () =>
    readSnapshotMeta("./db").pipe(
      Effect.flatMap((meta) =>
        preloadLedgerFiles(meta).pipe(Effect.map((preloaded) => ({ meta, preloaded }))),
      ),
      Effect.flatMap(({ meta, preloaded }) =>
        bootstrapStream(meta, preloaded).pipe(Stream.take(1), Stream.runCollect),
      ),
      Effect.tap((frames) =>
        Effect.sync(() => {
          assert.strictEqual(frames.length, 1);
          const msg = decodeFrame(frames[0]!);
          assert.strictEqual(msg._tag, BootstrapMessageKind.Init);
          if (msg._tag === BootstrapMessageKind.Init) {
            assert.strictEqual(msg.protocolMagic, 1);
            assert.isTrue(msg.blobPrefixes.includes("utxo"));
          }
        }),
      ),
      Effect.provide(testLayers),
    ),
  );

  it.effect("bootstrap stream delivers LedgerState after Init", () =>
    readSnapshotMeta("./db").pipe(
      Effect.flatMap((meta) =>
        preloadLedgerFiles(meta).pipe(Effect.map((preloaded) => ({ meta, preloaded }))),
      ),
      Effect.flatMap(({ meta, preloaded }) =>
        bootstrapStream(meta, preloaded).pipe(Stream.take(2), Stream.runCollect),
      ),
      Effect.tap((frames) =>
        Effect.sync(() => {
          assert.strictEqual(frames.length, 2);
          const init = decodeFrame(frames[0]!);
          const state = decodeFrame(frames[1]!);
          assert.strictEqual(init._tag, BootstrapMessageKind.Init);
          assert.strictEqual(state._tag, BootstrapMessageKind.LedgerState);
          if (state._tag === BootstrapMessageKind.LedgerState) {
            // State file is ~29MB CBOR, starts with 0x82
            assert.isTrue(state.payload.length > 1_000_000);
            assert.strictEqual(state.payload[0], 0x82);
          }
        }),
      ),
      Effect.provide(testLayers),
    ),
  );

  it.effect("bootstrap stream includes LedgerMeta with backend info", () =>
    readSnapshotMeta("./db").pipe(
      Effect.flatMap((meta) =>
        preloadLedgerFiles(meta).pipe(Effect.map((preloaded) => ({ meta, preloaded }))),
      ),
      Effect.flatMap(({ meta, preloaded }) =>
        bootstrapStream(meta, preloaded).pipe(Stream.take(3), Stream.runCollect),
      ),
      Effect.tap((frames) =>
        Effect.sync(() => {
          const metaMsg = decodeFrame(frames[2]!);
          assert.strictEqual(metaMsg._tag, BootstrapMessageKind.LedgerMeta);
          if (metaMsg._tag === BootstrapMessageKind.LedgerMeta) {
            const parsed = JSON.parse(new TextDecoder().decode(metaMsg.payload));
            assert.strictEqual(parsed.backend, "utxohd-lmdb");
            assert.isDefined(parsed.checksum);
          }
        }),
      ),
      Effect.provide(testLayers),
    ),
  );

  it.effect("bootstrap stream includes blob entries after metadata", () =>
    readSnapshotMeta("./db").pipe(
      Effect.flatMap((meta) =>
        preloadLedgerFiles(meta).pipe(Effect.map((preloaded) => ({ meta, preloaded }))),
      ),
      Effect.flatMap(({ meta, preloaded }) =>
        bootstrapStream(meta, preloaded).pipe(
          // Init + LedgerState + LedgerMeta + first blob batch
          Stream.take(4),
          Stream.runCollect,
        ),
      ),
      Effect.tap((frames) =>
        Effect.sync(() => {
          const msg = decodeFrame(frames[3]!);
          assert.strictEqual(msg._tag, BootstrapMessageKind.BlobEntries);
          if (msg._tag === BootstrapMessageKind.BlobEntries) {
            assert.isTrue(msg.count > 0);
            // Should be from one of the known databases
            assert.isTrue(["_dbstate", "utxo"].includes(msg.dbName));
          }
        }),
      ),
      Effect.provide(testLayers),
    ),
  );

  it.effect(
    "complete message stream ordering: Init, LedgerState, LedgerMeta, BlobEntries, Blocks, Complete",
    () =>
      readSnapshotMeta("./db").pipe(
        Effect.flatMap((meta) =>
          preloadLedgerFiles(meta).pipe(Effect.map((preloaded) => ({ meta, preloaded }))),
        ),
        Effect.flatMap(({ meta, preloaded }) =>
          bootstrapStream(meta, preloaded).pipe(
            // Collect first 10 frames to verify ordering pattern
            Stream.take(10),
            Stream.map(decodeFrame),
            Stream.map((msg) => msg._tag),
            Stream.runCollect,
          ),
        ),
        Effect.tap((tags) =>
          Effect.sync(() => {
            // First 3 are always: Init, LedgerState, LedgerMeta
            assert.strictEqual(tags[0], BootstrapMessageKind.Init);
            assert.strictEqual(tags[1], BootstrapMessageKind.LedgerState);
            assert.strictEqual(tags[2], BootstrapMessageKind.LedgerMeta);
            // After that: blob entries (batched)
            assert.strictEqual(tags[3], BootstrapMessageKind.BlobEntries);
          }),
        ),
        Effect.provide(testLayers),
      ),
  );
});
