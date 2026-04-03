import { describe, it, assert } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { readChunkBlocks, readAllChunks } from "../chunk-reader.ts"

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer)

describe("Chunk Reader", () => {
  it.effect("parses chunk 0 with correct block structure", () =>
    readChunkBlocks("./db/immutable", 0).pipe(
      Effect.map(Stream.fromIterable),
      Effect.flatMap(Stream.runCollect),
      Effect.tap((blocks) =>
        Effect.sync(() => {
          assert.isTrue(blocks.length > 0)
          for (const block of blocks) {
            assert.strictEqual(block.chunkNo, 0)
            assert.strictEqual(block.headerHash.length, 32)
            assert.isTrue(block.blockCbor.length > 0)
            assert.isTrue(block.slotNo >= 0n)
            assert.isTrue(block.blockCbor[0]! >= 0x80)
          }
        }),
      ),
      Effect.provide(platform),
    ),
  )

  it.effect("reads blocks with valid header metadata from secondary index", () =>
    readChunkBlocks("./db/immutable", 0).pipe(
      Effect.map(Stream.fromIterable),
      Effect.flatMap(Stream.runCollect),
      Effect.tap((blocks) =>
        Effect.sync(() => {
          for (const block of blocks) {
            assert.isTrue(block.headerOffset < block.blockCbor.length)
            assert.isTrue(block.headerSize <= block.blockCbor.length)
            assert.isTrue(block.crc > 0)
          }
        }),
      ),
      Effect.provide(platform),
    ),
  )

  it.effect("streams blocks across multiple chunks in slot order", () =>
    readAllChunks("./db/immutable").pipe(
      Stream.take(20),
      Stream.runCollect,
      Effect.tap((blocks) =>
        Effect.sync(() => {
          assert.strictEqual(blocks.length, 20)
          for (let i = 1; i < blocks.length; i++) {
            assert.isTrue(blocks[i]!.slotNo >= blocks[i - 1]!.slotNo)
          }
        }),
      ),
      Effect.provide(platform),
    ),
  )

  it.effect("assigns correct chunk numbers across chunks", () =>
    readAllChunks("./db/immutable").pipe(
      Stream.take(50),
      Stream.runCollect,
      Effect.tap((blocks) =>
        Effect.sync(() => {
          assert.strictEqual(blocks[0]!.chunkNo, 0)
          const chunkNos = new Set(blocks.map((b) => b.chunkNo))
          assert.isTrue(chunkNos.size >= 2)
        }),
      ),
      Effect.provide(platform),
    ),
  )
})
