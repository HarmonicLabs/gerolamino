#!/usr/bin/env bun
/**
 * Multi-run benchmark with 10-minute cap per run.
 * Usage: bun packages/ledger/src/__tests__/bench-multi.ts [gerolamino|legacy] [runs=5]
 */
import { Effect } from "effect";
import { decodeMultiEraBlock, isPostByronBlock } from "..";
import { readChunkBlocks, countChunks } from "./chunk-reader.ts";

const MAX_TIME_MS = 10 * 60 * 1000; // 10 minutes

const mode = process.argv[2] ?? "gerolamino";
const runs = parseInt(process.argv[3] ?? "5", 10);

const totalChunks = countChunks();

// Load decoder
if (mode !== "gerolamino") {
  console.error("Legacy mode removed — use benchmark-snapshot.ts for comparison benchmarks");
  process.exit(1);
}
const decodeBlock = (cbor: Uint8Array) => {
  const result = Effect.runSync(decodeMultiEraBlock(cbor));
  return { txCount: isPostByronBlock(result) ? result.txBodies.length : 0 };
};

console.log(`\n[${mode}] ${runs} runs, ${totalChunks} chunks, 10min cap per run\n`);

const results: Array<{
  blocks: number;
  txs: number;
  failures: number;
  elapsed: number;
  rss: number;
  capped: boolean;
}> = [];

for (let run = 0; run < runs; run++) {
  Bun.gc(true);
  const startMem = process.memoryUsage().rss;
  const start = performance.now();
  let blocks = 0,
    txs = 0,
    failures = 0;
  let capped = false;

  for (let chunkNo = 0; chunkNo < totalChunks; chunkNo++) {
    if (performance.now() - start > MAX_TIME_MS) {
      capped = true;
      break;
    }
    const chunkBlocks = await readChunkBlocks(chunkNo);
    for (const blockCbor of chunkBlocks) {
      blocks++;
      try {
        const { txCount } = decodeBlock(blockCbor);
        txs += txCount;
      } catch {
        failures++;
      }
    }
  }

  const elapsed = (performance.now() - start) / 1000;
  const rss = (process.memoryUsage().rss - startMem) / 1024 / 1024;
  results.push({ blocks, txs, failures, elapsed, rss, capped });

  const bps = (blocks / elapsed).toFixed(0);
  const extrapolated = capped
    ? ` (extrapolated: ${(4567786 / (blocks / elapsed)).toFixed(0)}s for full)`
    : "";
  console.log(
    `  Run ${run + 1}: ${blocks} blocks in ${elapsed.toFixed(1)}s = ${bps} blocks/s, ${failures} failures, RSS +${rss.toFixed(0)}MB${extrapolated}`,
  );
}

// Summary
const avgBps = results.reduce((sum, r) => sum + r.blocks / r.elapsed, 0) / results.length;
const avgRss = results.reduce((sum, r) => sum + r.rss, 0) / results.length;
const avgFailures = results.reduce((sum, r) => sum + r.failures, 0) / results.length;
console.log(
  `\n[${mode}] Average: ${avgBps.toFixed(0)} blocks/s, ${avgRss.toFixed(0)} MB RSS, ${avgFailures.toFixed(0)} failures`,
);
