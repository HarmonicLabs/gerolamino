/**
 * Bootstrap data streaming.
 * Streams Mithril snapshot data in the correct order.
 * Reads UTxO entries from BlobStore (LSM backend).
 */
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import type { BootstrapError } from "./errors.ts";
import { ChunkReadError } from "./errors.ts";
import { readAllChunks } from "./chunk-reader.ts";
import { MessageTag, encodeFrame, encodeInit, encodeBlock, encodeBlobBatch } from "bootstrap";
import { BlobStore, PREFIX_UTXO } from "storage/blob-store/index";

export class SnapshotMeta extends Schema.Class<SnapshotMeta>("SnapshotMeta")({
  protocolMagic: Schema.Number,
  snapshotSlot: Schema.BigInt,
  ledgerDir: Schema.String,
  immutableDir: Schema.String,
  lsmDir: Schema.String,
  totalChunks: Schema.Number,
}) {}

export const readSnapshotMeta = (snapshotPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const ledgerBase = path.join(snapshotPath, "ledger");
    const ledgerEntries = yield* fs
      .readDirectory(ledgerBase)
      .pipe(Effect.mapError((cause) => new ChunkReadError({ chunkNo: -1, cause })));

    // Find the primary snapshot slot directory (skip *_lsm suffixed dirs)
    const snapshotSlotStr = ledgerEntries.find((e) => !e.includes("_"))!;
    const snapshotSlot = BigInt(snapshotSlotStr);

    const ledgerDir = path.join(ledgerBase, snapshotSlotStr);
    const immutableDir = path.join(snapshotPath, "immutable");
    const lsmDir = path.join(snapshotPath, "lsm");

    const protocolMagic = parseInt(
      new TextDecoder().decode(yield* fs.readFile(path.join(snapshotPath, "protocolMagicId"))),
    );

    const chunkFiles = yield* fs
      .readDirectory(immutableDir)
      .pipe(Effect.mapError((cause) => new ChunkReadError({ chunkNo: -1, cause })));
    const totalChunks = chunkFiles.filter((f) => f.endsWith(".chunk")).length;

    return new SnapshotMeta({
      protocolMagic,
      snapshotSlot,
      ledgerDir,
      immutableDir,
      lsmDir,
      totalChunks,
    });
  });

export const bootstrapStream = (
  meta: SnapshotMeta,
): Stream.Stream<Uint8Array, BootstrapError | Schema.SchemaError, FileSystem.FileSystem | Path.Path | BlobStore> => {
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
