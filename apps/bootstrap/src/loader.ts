/**
 * Bootstrap data streaming.
 * Streams all Mithril snapshot data directly from disk in the correct order.
 */
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import type { BootstrapError } from "./errors.ts";
import { ChunkReadError } from "./errors.ts";
import { readAllChunks } from "./chunk-reader.ts";
import { iterateEntries, discoverLmdbDatabases, UtxoKeySchema } from "./lmdb-kv.ts";
import { MessageTag, encodeFrame, encodeInit, encodeBlock, encodeLmdbBatch } from "bootstrap";

export interface SnapshotMeta {
  readonly protocolMagic: number;
  readonly snapshotSlot: bigint;
  readonly ledgerDir: string;
  readonly immutableDir: string;
  readonly tablesDir: string;
  readonly lmdbDatabases: ReadonlyArray<string>;
  readonly totalChunks: number;
}

export const readSnapshotMeta = (snapshotPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const ledgerDir = path.join(snapshotPath, "ledger", "119401006");
    const immutableDir = path.join(snapshotPath, "immutable");
    const tablesDir = path.join(ledgerDir, "tables");

    const protocolMagic = parseInt(
      new TextDecoder().decode(yield* fs.readFile(path.join(snapshotPath, "protocolMagicId"))),
    );
    const lmdbDatabases = yield* discoverLmdbDatabases(tablesDir);
    const chunkFiles = yield* fs
      .readDirectory(immutableDir)
      .pipe(Effect.mapError((cause) => new ChunkReadError({ chunkNo: -1, cause })));
    const totalChunks = chunkFiles.filter((f) => f.endsWith(".chunk")).length;

    return {
      protocolMagic,
      snapshotSlot: 119401006n,
      ledgerDir,
      immutableDir,
      tablesDir,
      lmdbDatabases,
      totalChunks,
    };
  });

export const bootstrapStream = (
  meta: SnapshotMeta,
): Stream.Stream<
  Uint8Array,
  BootstrapError | Schema.SchemaError,
  FileSystem.FileSystem | Path.Path
> => {
  const initStream = Stream.succeed(
    encodeFrame(
      MessageTag.Init,
      encodeInit({
        protocolMagic: meta.protocolMagic,
        snapshotSlot: meta.snapshotSlot,
        totalChunks: meta.totalChunks,
        totalBlocks: 0,
        totalLmdbEntries: 0,
        lmdbDatabases: meta.lmdbDatabases,
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

  const lmdbStream = Stream.fromIterable(meta.lmdbDatabases).pipe(
    Stream.flatMap((dbName) =>
      iterateEntries(meta.tablesDir, dbName).pipe(
        Stream.mapEffect((entry) =>
          dbName === "utxo" && entry.key.length === 34
            ? Schema.decodeEffect(UtxoKeySchema)(entry.key).pipe(Effect.as(entry))
            : Effect.succeed(entry),
        ),
        Stream.grouped(500),
        Stream.map((batch) => encodeFrame(MessageTag.LmdbEntries, encodeLmdbBatch(dbName, batch))),
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
    Stream.concat(lmdbStream),
    Stream.concat(blockStream),
    Stream.concat(completeStream),
  );
};
