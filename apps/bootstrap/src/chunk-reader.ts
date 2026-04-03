/**
 * ImmutableDB chunk file parser.
 */
import _ from "lodash";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChunkReadError } from "./errors.ts";

export const ChunkBlock = Schema.Struct({
  chunkNo: Schema.Number,
  slotNo: Schema.BigInt,
  headerHash: Schema.Uint8Array,
  headerOffset: Schema.Number,
  headerSize: Schema.Number,
  crc: Schema.Number,
  blockCbor: Schema.Uint8Array,
});
export type ChunkBlock = typeof ChunkBlock.Type;

function readPrimaryOffsets(primary: Uint8Array): ReadonlyArray<number> {
  const dv = new DataView(primary.buffer, primary.byteOffset);
  const numSlots = (primary.length - 1) / 4;
  return _.range(numSlots).map((i) => dv.getUint32(1 + i * 4, false));
}

function* filledSlots(offsets: ReadonlyArray<number>): IterableIterator<number> {
  for (let i = 0; i + 1 < offsets.length; i++) {
    if (offsets[i] !== offsets[i + 1]) yield i;
  }
}

function readSecondaryEntry(secondaryDv: DataView, secondary: Uint8Array, secOff: number) {
  return {
    blockOff: secondaryDv.getBigUint64(secOff, false),
    headerOffset: secondaryDv.getUint16(secOff + 8, false),
    headerSize: secondaryDv.getUint16(secOff + 10, false),
    crc: secondaryDv.getUint32(secOff + 12, false),
    headerHash: new Uint8Array(secondary.buffer, secondary.byteOffset + secOff + 16, 32).slice(),
    slotNo: secondaryDv.getBigUint64(secOff + 48, false),
  };
}

function* parseChunkIter(
  chunkNo: number,
  primary: Uint8Array,
  secondary: Uint8Array,
  chunk: Uint8Array,
): IterableIterator<ChunkBlock> {
  if (primary[0] !== 1) {
    throw new ChunkReadError({ chunkNo, cause: `Invalid primary version: ${primary[0]}` });
  }

  const offsets = readPrimaryOffsets(primary);
  const secondaryDv = new DataView(secondary.buffer, secondary.byteOffset);

  const entries = Array.from(filledSlots(offsets), (relSlot) => {
    const secOff = offsets[relSlot]!;
    return readSecondaryEntry(secondaryDv, secondary, secOff);
  });

  for (const [entry, nextEntry] of _.zip(entries, [...entries.slice(1), undefined])) {
    if (!entry) continue;
    const blockStart = Number(entry.blockOff);
    const blockEnd = nextEntry ? Number(nextEntry.blockOff) : chunk.length;

    yield {
      chunkNo,
      slotNo: entry.slotNo,
      headerHash: entry.headerHash,
      headerOffset: entry.headerOffset,
      headerSize: entry.headerSize,
      crc: entry.crc,
      blockCbor: chunk.subarray(blockStart, blockEnd).slice(),
    };
  }
}

export const readChunkBlocks = (dir: string, chunkNo: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = String(chunkNo).padStart(5, "0");
    const chunkPath = (ext: string) => path.format({ dir, name: base, ext });
    const [primary, secondary, chunkData] = yield* Effect.all([
      fs.readFile(chunkPath(".primary")),
      fs.readFile(chunkPath(".secondary")),
      fs.readFile(chunkPath(".chunk")),
    ]);
    return parseChunkIter(chunkNo, primary, secondary, chunkData);
  }).pipe(Effect.mapError((cause) => new ChunkReadError({ chunkNo, cause })));

export const readAllChunks = (
  dir: string,
): Stream.Stream<ChunkBlock, ChunkReadError, FileSystem.FileSystem | Path.Path> =>
  Stream.fromEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = yield* fs.readDirectory(dir);
      return files
        .filter((f: string) => f.endsWith(".chunk"))
        .map((f: string) => parseInt(path.basename(f, ".chunk")))
        .sort((a: number, b: number) => a - b);
    }).pipe(Effect.mapError((cause) => new ChunkReadError({ chunkNo: -1, cause }))),
  ).pipe(
    Stream.flatMap(Stream.fromIterable),
    Stream.flatMap((chunkNo) =>
      Stream.fromEffect(readChunkBlocks(dir, chunkNo)).pipe(Stream.flatMap(Stream.fromIterable)),
    ),
  );
