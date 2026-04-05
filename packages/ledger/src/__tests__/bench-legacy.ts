#!/usr/bin/env bun
/**
 * Benchmark: cardano-ledger-ts (legacy) - full Mithril snapshot decode
 */
import pathNode from "path";
import { fileURLToPath } from "url";

const __dir = pathNode.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = pathNode.resolve(__dir, "../../../..");
const IMMUTABLE_DIR = pathNode.join(WORKSPACE, "apps/bootstrap/db/immutable");
const LEGACY_PATH = pathNode.resolve(WORKSPACE, "..", "cardano-ledger-ts");

const { MultiEraBlock } = await import(`${LEGACY_PATH}/src/eras/common/MultiEraBlock.ts`);

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
