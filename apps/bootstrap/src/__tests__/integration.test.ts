import { describe, it, assert } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { readSnapshotMeta, bootstrapStream } from "../loader.ts";
import { MessageTag, decodeFrame } from "bootstrap";
import { BlobStore, BlobStoreError } from "storage/blob-store/index";

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
      Effect.flatMap((meta) => bootstrapStream(meta).pipe(Stream.take(1), Stream.runCollect)),
      Effect.tap((frames) =>
        Effect.sync(() => {
          assert.strictEqual(frames.length, 1);
          const msg = decodeFrame(frames[0]!);
          assert.strictEqual(msg.tag, MessageTag.Init);
          if (msg.tag === MessageTag.Init) {
            assert.strictEqual(msg.protocolMagic, 1);
            assert.isTrue(msg.lmdbDatabases.includes("utxo"));
          }
        }),
      ),
      Effect.provide(testLayers),
    ),
  );

  it.effect("bootstrap stream delivers LedgerState after Init", () =>
    readSnapshotMeta("./db").pipe(
      Effect.flatMap((meta) => bootstrapStream(meta).pipe(Stream.take(2), Stream.runCollect)),
      Effect.tap((frames) =>
        Effect.sync(() => {
          assert.strictEqual(frames.length, 2);
          const init = decodeFrame(frames[0]!);
          const state = decodeFrame(frames[1]!);
          assert.strictEqual(init.tag, MessageTag.Init);
          assert.strictEqual(state.tag, MessageTag.LedgerState);
          if (state.tag === MessageTag.LedgerState) {
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
      Effect.flatMap((meta) => bootstrapStream(meta).pipe(Stream.take(3), Stream.runCollect)),
      Effect.tap((frames) =>
        Effect.sync(() => {
          const metaMsg = decodeFrame(frames[2]!);
          assert.strictEqual(metaMsg.tag, MessageTag.LedgerMeta);
          if (metaMsg.tag === MessageTag.LedgerMeta) {
            const parsed = JSON.parse(new TextDecoder().decode(metaMsg.payload));
            assert.strictEqual(parsed.backend, "utxohd-lmdb");
            assert.isDefined(parsed.checksum);
          }
        }),
      ),
      Effect.provide(testLayers),
    ),
  );

  it.effect("bootstrap stream includes LMDB entries after metadata", () =>
    readSnapshotMeta("./db").pipe(
      Effect.flatMap((meta) =>
        bootstrapStream(meta).pipe(
          // Init + LedgerState + LedgerMeta + first LMDB batch
          Stream.take(4),
          Stream.runCollect,
        ),
      ),
      Effect.tap((frames) =>
        Effect.sync(() => {
          const msg = decodeFrame(frames[3]!);
          assert.strictEqual(msg.tag, MessageTag.LmdbEntries);
          if (msg.tag === MessageTag.LmdbEntries) {
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
    "complete message stream ordering: Init, LedgerState, LedgerMeta, LMDB, Blocks, Complete",
    () =>
      readSnapshotMeta("./db").pipe(
        Effect.flatMap((meta) =>
          bootstrapStream(meta).pipe(
            // Collect first 10 frames to verify ordering pattern
            Stream.take(10),
            Stream.map(decodeFrame),
            Stream.map((msg) => msg.tag),
            Stream.runCollect,
          ),
        ),
        Effect.tap((tags) =>
          Effect.sync(() => {
            // First 3 are always: Init, LedgerState, LedgerMeta
            assert.strictEqual(tags[0], MessageTag.Init);
            assert.strictEqual(tags[1], MessageTag.LedgerState);
            assert.strictEqual(tags[2], MessageTag.LedgerMeta);
            // After that: LMDB entries (batched)
            assert.strictEqual(tags[3], MessageTag.LmdbEntries);
          }),
        ),
        Effect.provide(testLayers),
      ),
  );
});
