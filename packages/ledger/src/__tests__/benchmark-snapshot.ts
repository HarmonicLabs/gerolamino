#!/usr/bin/env bun
/**
 * Benchmark: Full Mithril snapshot decode comparison
 *
 * Compares gerolamino/packages/ledger vs cardano-ledger-ts
 * on decoding ALL blocks from the preprod Mithril snapshot.
 *
 * Run: bun packages/ledger/src/__tests__/benchmark-snapshot.ts
 */
import { Effect } from "effect";
import { decodeMultiEraBlock, isPostByronBlock } from "..";
import { MultiEraBlock } from "../../../../../cardano-ledger-ts/src/eras/common/MultiEraBlock.ts";
import { readChunkBlocks, countChunks, IMMUTABLE_DIR } from "./chunk-reader.ts";

// ---------------------------------------------------------------------------
// Benchmark: gerolamino ledger (Effect-TS)
// ---------------------------------------------------------------------------

async function benchGerolamino(totalChunks: number) {
  console.log("\n=== gerolamino/packages/ledger (Effect-TS) ===");
  const startMem = process.memoryUsage();
  const start = performance.now();

  let totalBlocks = 0;
  let totalTxs = 0;
  let failures = 0;

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
    if ((chunkNo + 1) % 1000 === 0) {
      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      console.log(`  ${chunkNo + 1}/${totalChunks} chunks, ${totalBlocks} blocks, ${elapsed}s`);
    }
  }

  const elapsed = (performance.now() - start) / 1000;
  const endMem = process.memoryUsage();
  const memDelta = (endMem.rss - startMem.rss) / 1024 / 1024;

  console.log(`  Done: ${totalBlocks} blocks, ${totalTxs} txs, ${failures} failures`);
  console.log(`  Time: ${elapsed.toFixed(2)}s`);
  console.log(
    `  RSS delta: ${memDelta.toFixed(1)} MB (start: ${(startMem.rss / 1024 / 1024).toFixed(0)} MB, end: ${(endMem.rss / 1024 / 1024).toFixed(0)} MB)`,
  );
  console.log(`  Throughput: ${(totalBlocks / elapsed).toFixed(0)} blocks/s`);

  return { totalBlocks, totalTxs, failures, elapsed, memDelta };
}

// ---------------------------------------------------------------------------
// Benchmark: cardano-ledger-ts (legacy)
// ---------------------------------------------------------------------------

async function benchLegacy(totalChunks: number) {
  console.log("\n=== cardano-ledger-ts (legacy) ===");

  const startMem = process.memoryUsage();
  const start = performance.now();

  let totalBlocks = 0;
  let totalTxs = 0;
  let failures = 0;

  for (let chunkNo = 0; chunkNo < totalChunks; chunkNo++) {
    const blocks = await readChunkBlocks(chunkNo);
    for (const blockCbor of blocks) {
      totalBlocks++;
      try {
        const result = MultiEraBlock.fromCbor(blockCbor);
        if (result && result.block) {
          totalTxs += result.block.transactionBodies?.length ?? 0;
        }
      } catch {
        failures++;
      }
    }
    if ((chunkNo + 1) % 1000 === 0) {
      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      console.log(`  ${chunkNo + 1}/${totalChunks} chunks, ${totalBlocks} blocks, ${elapsed}s`);
    }
  }

  const elapsed = (performance.now() - start) / 1000;
  const endMem = process.memoryUsage();
  const memDelta = (endMem.rss - startMem.rss) / 1024 / 1024;

  console.log(`  Done: ${totalBlocks} blocks, ${totalTxs} txs, ${failures} failures`);
  console.log(`  Time: ${elapsed.toFixed(2)}s`);
  console.log(
    `  RSS delta: ${memDelta.toFixed(1)} MB (start: ${(startMem.rss / 1024 / 1024).toFixed(0)} MB, end: ${(endMem.rss / 1024 / 1024).toFixed(0)} MB)`,
  );
  console.log(`  Throughput: ${(totalBlocks / elapsed).toFixed(0)} blocks/s`);

  return { totalBlocks, totalTxs, failures, elapsed, memDelta };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const totalChunks = countChunks();
  console.log(`\nMithril snapshot benchmark: ${totalChunks} chunks in ${IMMUTABLE_DIR}`);

  // Run gerolamino first
  const gero = await benchGerolamino(totalChunks);

  // Force GC between benchmarks
  if (typeof Bun !== "undefined") Bun.gc(true);

  // Run legacy
  let legacy;
  try {
    legacy = await benchLegacy(totalChunks);
  } catch (e) {
    console.log("\n  Legacy benchmark failed:", e);
    legacy = null;
  }

  // Summary
  console.log("\n=== Comparison ===");
  console.log(
    `  gerolamino: ${gero.elapsed.toFixed(2)}s, ${gero.memDelta.toFixed(1)} MB RSS delta, ${(gero.totalBlocks / gero.elapsed).toFixed(0)} blocks/s`,
  );
  if (legacy) {
    console.log(
      `  legacy:     ${legacy.elapsed.toFixed(2)}s, ${legacy.memDelta.toFixed(1)} MB RSS delta, ${(legacy.totalBlocks / legacy.elapsed).toFixed(0)} blocks/s`,
    );
    const speedup = legacy.elapsed / gero.elapsed;
    console.log(
      `  Speedup: ${speedup.toFixed(2)}x ${speedup > 1 ? "(gerolamino faster)" : "(legacy faster)"}`,
    );
  }
}

main().catch(console.error);
