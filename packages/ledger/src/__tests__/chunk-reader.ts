/**
 * Shared ImmutableDB chunk reader for benchmarks and tests.
 *
 * Reads Ouroboros ImmutableDB triplets (.primary, .secondary, .chunk)
 * and extracts individual block byte arrays.
 */
const __dir = import.meta.dirname;
export const WORKSPACE = new URL("../../../..", `file://${__dir}/`).pathname.replace(/\/$/, "");
export const IMMUTABLE_DIR = `${WORKSPACE}/apps/bootstrap/db/immutable`;

/**
 * Parse a single ImmutableDB chunk triplet and return the raw block bytes.
 */
export async function readChunkBlocks(
  chunkNo: number,
  immutableDir: string = IMMUTABLE_DIR,
): Promise<ReadonlyArray<Uint8Array>> {
  const base = String(chunkNo).padStart(5, "0");
  const [primary, secondary, chunk] = await Promise.all([
    Bun.file(`${immutableDir}/${base}.primary`)
      .arrayBuffer()
      .then((b) => new Uint8Array(b)),
    Bun.file(`${immutableDir}/${base}.secondary`)
      .arrayBuffer()
      .then((b) => new Uint8Array(b)),
    Bun.file(`${immutableDir}/${base}.chunk`)
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

/**
 * Count the number of .chunk files in the ImmutableDB directory.
 */
export function countChunks(immutableDir: string = IMMUTABLE_DIR): number {
  return Bun.spawnSync(["ls", immutableDir])
    .stdout.toString()
    .split("\n")
    .filter((f) => f.endsWith(".chunk")).length;
}
