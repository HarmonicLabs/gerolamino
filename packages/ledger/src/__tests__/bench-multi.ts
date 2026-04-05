#!/usr/bin/env bun
/**
 * Multi-run benchmark with 10-minute cap per run.
 * Usage: bun packages/ledger/src/__tests__/bench-multi.ts [gerolamino|legacy] [runs=5]
 */
import { Effect } from "effect";
import pathNode from "path";
import { fileURLToPath } from "url";

const __dir = pathNode.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = pathNode.resolve(__dir, "../../../..");
const IMMUTABLE_DIR = pathNode.join(WORKSPACE, "apps/bootstrap/db/immutable");
const MAX_TIME_MS = 10 * 60 * 1000; // 10 minutes

const mode = process.argv[2] ?? "gerolamino";
const runs = parseInt(process.argv[3] ?? "5", 10);

async function readChunkBlocks(chunkNo: number): Promise<ReadonlyArray<Uint8Array>> {
  const base = String(chunkNo).padStart(5, "0");
  const [primary, secondary, chunk] = await Promise.all([
    Bun.file(`${IMMUTABLE_DIR}/${base}.primary`)
      .arrayBuffer()
      .then((b) => new Uint8Array(b)),
    Bun.file(`${IMMUTABLE_DIR}/${base}.secondary`)
      .arrayBuffer()
      .then((b) => new Uint8Array(b)),
    Bun.file(`${IMMUTABLE_DIR}/${base}.chunk`)
      .arrayBuffer()
      .then((b) => new Uint8Array(b)),
  ]);
  if (primary.length < 5 || primary[0] !== 1) return [];
  const numSlots = (primary.length - 1) / 4;
  const primaryDv = new DataView(primary.buffer, primary.byteOffset);
  const secondaryDv = new DataView(secondary.buffer, secondary.byteOffset);
  const offsets: number[] = [];
  for (let i = 0; i < numSlots; i++) offsets.push(primaryDv.getUint32(1 + i * 4, false));
  const entries: Array<{ blockOff: bigint }> = [];
  for (let i = 0; i + 1 < offsets.length; i++) {
    if (offsets[i] !== offsets[i + 1])
      entries.push({ blockOff: secondaryDv.getBigUint64(offsets[i]!, false) });
  }
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < entries.length; i++) {
    const s = Number(entries[i]!.blockOff);
    const e = i + 1 < entries.length ? Number(entries[i + 1]!.blockOff) : chunk.length;
    blocks.push(chunk.subarray(s, e).slice());
  }
  return blocks;
}

const totalChunks = Bun.spawnSync(["ls", IMMUTABLE_DIR])
  .stdout.toString()
  .split("\n")
  .filter((f) => f.endsWith(".chunk")).length;

// Load decoder
let decodeBlock: (cbor: Uint8Array) => { txCount: number };
if (mode === "gerolamino") {
  const { decodeMultiEraBlock } = await import("../lib/block/block.ts");
  decodeBlock = (cbor) => {
    const result = Effect.runSync(decodeMultiEraBlock(cbor));
    return { txCount: result._tag === "postByron" ? result.txBodies.length : 0 };
  };
} else {
  const { MultiEraBlock } = await import(
    `${pathNode.resolve(WORKSPACE, "..", "cardano-ledger-ts")}/src/eras/common/MultiEraBlock.ts`
  );
  decodeBlock = (cbor) => {
    const result = MultiEraBlock.fromCbor(cbor);
    return { txCount: result?.body?.txBodies?.length ?? 0 };
  };
}

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
