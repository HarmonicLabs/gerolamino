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
import { parseSync, type CborSchemaType, CborKinds } from "cbor-schema";
import { decodeMultiEraBlock } from "../lib/block/block.ts";
import pathNode from "path";
import { fileURLToPath } from "url";

const __dir = pathNode.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = pathNode.resolve(__dir, "../../../..");
const IMMUTABLE_DIR = pathNode.join(WORKSPACE, "apps/bootstrap/db/immutable");

// ---------------------------------------------------------------------------
// Chunk reader (shared between both benchmarks)
// ---------------------------------------------------------------------------

async function readChunkBlocks(chunkNo: number): Promise<ReadonlyArray<Uint8Array>> {
  const base = String(chunkNo).padStart(5, "0");
  const [primary, secondary, chunk] = await Promise.all([
    Bun.file(`${IMMUTABLE_DIR}/${base}.primary`).arrayBuffer().then((b) => new Uint8Array(b)),
    Bun.file(`${IMMUTABLE_DIR}/${base}.secondary`).arrayBuffer().then((b) => new Uint8Array(b)),
    Bun.file(`${IMMUTABLE_DIR}/${base}.chunk`).arrayBuffer().then((b) => new Uint8Array(b)),
  ]);

  if (primary.length < 5 || primary[0] !== 1) return [];

  const numSlots = (primary.length - 1) / 4;
  const primaryDv = new DataView(primary.buffer, primary.byteOffset);
  const secondaryDv = new DataView(secondary.buffer, secondary.byteOffset);

  const offsets: number[] = [];
  for (let i = 0; i < numSlots; i++) offsets.push(primaryDv.getUint32(1 + i * 4, false));

  interface Entry { blockOff: bigint }
  const entries: Entry[] = [];
  for (let i = 0; i + 1 < offsets.length; i++) {
    if (offsets[i] !== offsets[i + 1]) {
      const secOff = offsets[i]!;
      entries.push({ blockOff: secondaryDv.getBigUint64(secOff, false) });
    }
  }

  const blocks: Uint8Array[] = [];
  for (let i = 0; i < entries.length; i++) {
    const blockStart = Number(entries[i]!.blockOff);
    const blockEnd = i + 1 < entries.length ? Number(entries[i + 1]!.blockOff) : chunk.length;
    blocks.push(chunk.subarray(blockStart, blockEnd).slice());
  }
  return blocks;
}

function countChunks(): number {
  const files = Bun.spawnSync(["ls", IMMUTABLE_DIR]).stdout.toString().split("\n");
  return files.filter((f) => f.endsWith(".chunk")).length;
}

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
        if (result._tag === "postByron") totalTxs += result.txBodies.length;
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
  console.log(`  RSS delta: ${memDelta.toFixed(1)} MB (start: ${(startMem.rss / 1024 / 1024).toFixed(0)} MB, end: ${(endMem.rss / 1024 / 1024).toFixed(0)} MB)`);
  console.log(`  Throughput: ${(totalBlocks / elapsed).toFixed(0)} blocks/s`);

  return { totalBlocks, totalTxs, failures, elapsed, memDelta };
}

// ---------------------------------------------------------------------------
// Benchmark: cardano-ledger-ts (legacy)
// ---------------------------------------------------------------------------

async function benchLegacy(totalChunks: number) {
  console.log("\n=== cardano-ledger-ts (legacy) ===");

  // Dynamic import to avoid build-time dependency
  const legacyPath = pathNode.resolve(WORKSPACE, "..", "cardano-ledger-ts");
  const { MultiEraBlock } = await import(`${legacyPath}/src/eras/common/MultiEraBlock.ts`);

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
        // Count txs if available
        if (result && result.body) {
          totalTxs += result.body.txBodies?.length ?? 0;
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
  console.log(`  RSS delta: ${memDelta.toFixed(1)} MB (start: ${(startMem.rss / 1024 / 1024).toFixed(0)} MB, end: ${(endMem.rss / 1024 / 1024).toFixed(0)} MB)`);
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
  console.log(`  gerolamino: ${gero.elapsed.toFixed(2)}s, ${gero.memDelta.toFixed(1)} MB RSS delta, ${(gero.totalBlocks / gero.elapsed).toFixed(0)} blocks/s`);
  if (legacy) {
    console.log(`  legacy:     ${legacy.elapsed.toFixed(2)}s, ${legacy.memDelta.toFixed(1)} MB RSS delta, ${(legacy.totalBlocks / legacy.elapsed).toFixed(0)} blocks/s`);
    const speedup = legacy.elapsed / gero.elapsed;
    console.log(`  Speedup: ${speedup.toFixed(2)}x ${speedup > 1 ? "(gerolamino faster)" : "(legacy faster)"}`);
  }
}

main().catch(console.error);
