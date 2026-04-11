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
import { BlobStore } from "storage";

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

  // State/meta files exist in Mithril snapshots but not in V2LSM node DBs.
  // Skip gracefully if they don't exist.
  const stateStream = Stream.fromEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const statePath = path.join(meta.ledgerDir, "state");
      if (!(yield* fs.exists(statePath))) return undefined;
      const bytes = yield* fs.readFile(statePath);
      return encodeFrame(MessageTag.LedgerState, bytes);
    }).pipe(Effect.mapError((cause) => new ChunkReadError({ chunkNo: -1, cause }))),
  ).pipe(Stream.filter((f): f is Uint8Array => f !== undefined));

  const metaStream = Stream.fromEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const metaPath = path.join(meta.ledgerDir, "meta");
      if (!(yield* fs.exists(metaPath))) return undefined;
      const bytes = yield* fs.readFile(metaPath);
      return encodeFrame(MessageTag.LedgerMeta, bytes);
    }).pipe(Effect.mapError((cause) => new ChunkReadError({ chunkNo: -1, cause }))),
  ).pipe(Stream.filter((f): f is Uint8Array => f !== undefined));

  // Stream UTxO entries from BlobStore (LSM backend) via scan.
  // V2LSM tables store raw MemPack keys without our PREFIX_UTXO,
  // so scan with empty prefix to get all entries (entire table is UTxOs).
  // Wire format sends raw MemPack keys — client adds PREFIX_UTXO on receipt.
  const utxoStream = Stream.fromEffect(
    Effect.gen(function* () {
      const store = yield* BlobStore;
      return store;
    }),
  ).pipe(
    Stream.flatMap((store) =>
      store.scan(new Uint8Array(0)).pipe(
        Stream.grouped(500),
        Stream.map((batch) =>
          encodeFrame(
            MessageTag.BlobEntries,
            encodeBlobBatch(
              "utxo",
              batch.map((e: { readonly key: Uint8Array; readonly value: Uint8Array }) => ({
                key: e.key,
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
