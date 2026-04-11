/**
 * Bootstrap data streaming.
 * Streams Mithril snapshot data in the correct order.
 * Reads UTxO entries from BlobStore (LSM backend).
 */
import { Effect, FileSystem, Option, Path, Stream } from "effect";
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

/**
 * Pre-load ledger state and meta files at startup (when FileSystem is available).
 * HTTP request handlers may run in a scope without FileSystem — reading
 * at startup avoids this issue and also prevents re-reading 28MB per connection.
 */
export const preloadLedgerFiles = (meta: SnapshotMeta) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const statePath = path.join(meta.ledgerDir, "state");
    const stateBytes = (yield* fs.exists(statePath))
      ? yield* fs
          .readFile(statePath)
          .pipe(Effect.tapError((e) => Effect.logWarning(`Failed to read ledger state: ${e}`)))
          .pipe(Effect.option)
      : Option.none<Uint8Array>();

    const metaPath = path.join(meta.ledgerDir, "meta");
    const metaBytes = (yield* fs.exists(metaPath))
      ? yield* fs
          .readFile(metaPath)
          .pipe(Effect.tapError((e) => Effect.logWarning(`Failed to read ledger meta: ${e}`)))
          .pipe(Effect.option)
      : Option.none<Uint8Array>();

    yield* Effect.log(
      `Preloaded: state=${Option.isSome(stateBytes) ? `${Option.getOrThrow(stateBytes).length} bytes` : "missing"}, ` +
        `meta=${Option.isSome(metaBytes) ? `${Option.getOrThrow(metaBytes).length} bytes` : "missing"}`,
    );

    return { stateBytes, metaBytes };
  });

export type PreloadedLedger = {
  readonly stateBytes: Option.Option<Uint8Array>;
  readonly metaBytes: Option.Option<Uint8Array>;
};

export const bootstrapStream = (
  meta: SnapshotMeta,
  preloaded: PreloadedLedger,
): Stream.Stream<Uint8Array, BootstrapError, BlobStore | FileSystem.FileSystem | Path.Path> => {
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

  // Use pre-loaded bytes — avoids FileSystem dependency in request handler scope
  const stateStream = Option.isSome(preloaded.stateBytes)
    ? Stream.succeed(encodeFrame(MessageTag.LedgerState, Option.getOrThrow(preloaded.stateBytes)))
    : Stream.empty;

  const metaStream = Option.isSome(preloaded.metaBytes)
    ? Stream.succeed(encodeFrame(MessageTag.LedgerMeta, Option.getOrThrow(preloaded.metaBytes)))
    : Stream.empty;

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
