/**
 * Bootstrap data streaming.
 * Streams Mithril snapshot data in the correct order.
 * Reads UTxO entries from BlobStore (LSM backend).
 */
import { Effect, FileSystem, Path, Stream } from "effect";
import type { BootstrapError } from "./errors.ts";
import { ChunkReadError } from "./errors.ts";
import { readAllChunks } from "./chunk-reader.ts";
import {
  MessageTag,
  encodeFrame,
  encodeInit,
  encodeBlock,
  encodeBlobBatch,
  SnapshotMeta,
  readSnapshotMeta,
} from "bootstrap";
import { BlobStore, PREFIX_UTXO } from "storage/blob-store/index";

// Re-export for consumers that used the old location
export { SnapshotMeta, readSnapshotMeta } from "bootstrap";

export const bootstrapStream = (
  meta: SnapshotMeta,
): Stream.Stream<Uint8Array, BootstrapError, FileSystem.FileSystem | Path.Path | BlobStore> => {
  const initStream = Stream.succeed(
    encodeFrame(
      MessageTag.Init,
      encodeInit({
        protocolMagic: meta.protocolMagic,
        snapshotSlot: meta.snapshotSlot,
        totalChunks: meta.totalChunks,
        totalBlocks: 0,
        totalBlobEntries: 0,
        blobPrefixes: ["utxo"],
      }),
    ),
  );

  const stateStream = Stream.fromEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bytes = yield* fs.readFile(path.join(meta.ledgerDir, "state"));
      return encodeFrame(MessageTag.LedgerState, bytes);
    }).pipe(Effect.mapError((cause) => new ChunkReadError({ chunkNo: -1, cause }))),
  );

  const metaStream = Stream.fromEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bytes = yield* fs.readFile(path.join(meta.ledgerDir, "meta"));
      return encodeFrame(MessageTag.LedgerMeta, bytes);
    }).pipe(Effect.mapError((cause) => new ChunkReadError({ chunkNo: -1, cause }))),
  );

  // Stream UTxO entries from BlobStore (LSM backend) via scan(prefix)
  const utxoStream = Stream.fromEffect(
    Effect.gen(function* () {
      const store = yield* BlobStore;
      return store;
    }),
  ).pipe(
    Stream.flatMap((store) =>
      store.scan(PREFIX_UTXO).pipe(
        Stream.grouped(500),
        Stream.map((batch) =>
          encodeFrame(
            MessageTag.BlobEntries,
            encodeBlobBatch(
              "utxo",
              batch.map((e: { readonly key: Uint8Array; readonly value: Uint8Array }) => ({
                // Strip "utxo" prefix (4 bytes) — wire format expects raw MemPack keys
                key: e.key.slice(4),
                value: e.value,
              })),
            ),
          ),
        ),
      ),
    ),
  );

  const blockStream = readAllChunks(meta.immutableDir).pipe(
    Stream.map((block) => encodeFrame(MessageTag.Block, encodeBlock(block))),
  );

  const completeStream = Stream.succeed(encodeFrame(MessageTag.Complete, new Uint8Array(0)));

  return initStream.pipe(
    Stream.concat(stateStream),
    Stream.concat(metaStream),
    Stream.concat(utxoStream),
    Stream.concat(blockStream),
    Stream.concat(completeStream),
  );
};
