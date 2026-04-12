#!/usr/bin/env bun
/**
 * Benchmark: cardano-ledger-ts (legacy) - full Mithril snapshot decode
 */
import { MultiEraBlock } from "../../../../../cardano-ledger-ts/src/eras/common/MultiEraBlock.ts";
import { readChunkBlocks, countChunks } from "./chunk-reader.ts";

const totalChunks = countChunks();
console.log(`[legacy] ${totalChunks} chunks`);

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
      const result = MultiEraBlock.fromCbor(blockCbor);
      if (result?.body?.txBodies) totalTxs += result.body.txBodies.length;
    } catch {
      failures++;
    }
  }
  if ((chunkNo + 1) % 1000 === 0)
    console.log(
      `[legacy] ${chunkNo + 1}/${totalChunks} chunks, ${totalBlocks} blocks, ${((performance.now() - start) / 1000).toFixed(1)}s`,
    );
}

const elapsed = (performance.now() - start) / 1000;
const endMem = process.memoryUsage();
console.log(`[legacy] DONE: ${totalBlocks} blocks, ${totalTxs} txs, ${failures} failures`);
console.log(
  `[legacy] Time: ${elapsed.toFixed(2)}s | RSS: ${(startMem.rss / 1024 / 1024).toFixed(0)}→${(endMem.rss / 1024 / 1024).toFixed(0)} MB | ${(totalBlocks / elapsed).toFixed(0)} blocks/s`,
);
