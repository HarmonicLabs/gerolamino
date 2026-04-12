#!/usr/bin/env bun
/**
 * Benchmark: gerolamino ledger (Effect-TS) - full Mithril snapshot decode
 */
import { Effect } from "effect";
import { decodeMultiEraBlock, isPostByronBlock } from "..";
import { readChunkBlocks, countChunks } from "./chunk-reader.ts";

const totalChunks = countChunks();
console.log(`[gerolamino] ${totalChunks} chunks`);

const startMem = process.memoryUsage();
const start = performance.now();
let totalBlocks = 0,
  totalTxs = 0,
  failures = 0;

for (let chunkNo = 0; chunkNo < totalChunks; chunkNo++) {
  const blocks = await readChunkBlocks(chunkNo);
  for (const blockCbor of blocks) {
    totalBlocks++;
    try {
      const result = Effect.runSync(decodeMultiEraBlock(blockCbor));
      if (isPostByronBlock(result)) totalTxs += result.txBodies.length;
    } catch {
      failures++;
    }
  }
  if ((chunkNo + 1) % 1000 === 0)
    console.log(
      `[gerolamino] ${chunkNo + 1}/${totalChunks} chunks, ${totalBlocks} blocks, ${((performance.now() - start) / 1000).toFixed(1)}s`,
    );
}

const elapsed = (performance.now() - start) / 1000;
const endMem = process.memoryUsage();
console.log(`[gerolamino] DONE: ${totalBlocks} blocks, ${totalTxs} txs, ${failures} failures`);
console.log(
  `[gerolamino] Time: ${elapsed.toFixed(2)}s | RSS: ${(startMem.rss / 1024 / 1024).toFixed(0)}→${(endMem.rss / 1024 / 1024).toFixed(0)} MB | ${(totalBlocks / elapsed).toFixed(0)} blocks/s`,
);
