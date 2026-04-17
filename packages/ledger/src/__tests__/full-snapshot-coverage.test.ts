/**
 * Full Mithril snapshot coverage test.
 *
 * Decodes EVERY block from the real preprod snapshot to verify 100% decode coverage.
 * Uses Effect FileSystem abstraction with BunFileSystem layer.
 */
import { describe, it, assert } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { CborKinds } from "codecs";
import { decodeMultiEraBlock, isByronBlock, type BlockHeader, decodeExtLedgerState } from "..";
import { WORKSPACE, IMMUTABLE_DIR } from "./chunk-reader.ts";
import pathNode from "path";

const STATE_PATH = pathNode.join(WORKSPACE, "apps/bootstrap/db/ledger/119401006/state");

const FsLayer = BunFileSystem.layer;

// ---------------------------------------------------------------------------
// Chunk parser using Effect FileSystem
// ---------------------------------------------------------------------------

function readChunkBlocks(chunkNo: number) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = String(chunkNo).padStart(5, "0");
    const [primary, secondary, chunk] = yield* Effect.all([
      fs.readFile(`${IMMUTABLE_DIR}/${base}.primary`),
      fs.readFile(`${IMMUTABLE_DIR}/${base}.secondary`),
      fs.readFile(`${IMMUTABLE_DIR}/${base}.chunk`),
    ]);

    if (primary.length < 5 || primary[0] !== 1) return [];

    const numSlots = (primary.length - 1) / 4;
    const primaryDv = new DataView(primary.buffer, primary.byteOffset);
    const secondaryDv = new DataView(secondary.buffer, secondary.byteOffset);

    const offsets: number[] = [];
    for (let i = 0; i < numSlots; i++) offsets.push(primaryDv.getUint32(1 + i * 4, false));

    interface Entry {
      blockOff: bigint;
      slotNo: bigint;
    }
    const entries: Entry[] = [];
    for (let i = 0; i + 1 < offsets.length; i++) {
      if (offsets[i] !== offsets[i + 1]) {
        const secOff = offsets[i]!;
        entries.push({
          blockOff: secondaryDv.getBigUint64(secOff, false),
          slotNo: secondaryDv.getBigUint64(secOff + 48, false),
        });
      }
    }

    const blocks: Array<{ slotNo: bigint; blockCbor: Uint8Array }> = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const blockStart = Number(entry.blockOff);
      const blockEnd = i + 1 < entries.length ? Number(entries[i + 1]!.blockOff) : chunk.length;
      blocks.push({
        slotNo: entry.slotNo,
        blockCbor: chunk.subarray(blockStart, blockEnd).slice(),
      });
    }
    return blocks;
  }).pipe(Effect.provide(FsLayer));
}

function countChunks() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs.readDirectory(IMMUTABLE_DIR);
    return files.filter((f) => f.endsWith(".chunk")).length;
  }).pipe(Effect.provide(FsLayer));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Full Mithril snapshot coverage", () => {
  it.effect(
    "decodes ALL blocks from ALL chunks with zero failures",
    () =>
      Effect.gen(function* () {
        const totalChunks = yield* countChunks();
        assert.isTrue(totalChunks > 100, `Expected >100 chunks, got ${totalChunks}`);

        let totalBlocks = 0;
        let byronBlocks = 0;
        let postByronBlocks = 0;
        let totalTxBodies = 0;
        let headersDecoded = 0;
        const failures: string[] = [];
        const MAX_FAILURES = 20;

        for (let chunkNo = 0; chunkNo < totalChunks; chunkNo++) {
          const blocks = yield* readChunkBlocks(chunkNo);

          for (const { slotNo, blockCbor } of blocks) {
            totalBlocks++;
            try {
              const blockResult = Effect.runSync(decodeMultiEraBlock(blockCbor));

              if (isByronBlock(blockResult)) {
                byronBlocks++;
              } else {
                postByronBlocks++;
                totalTxBodies += blockResult.txBodies.length;

                const hdr = blockResult.header;
                headersDecoded++;
                if (
                  hdr.issuerVKey.length !== 32 ||
                  hdr.vrfVKey.length !== 32 ||
                  hdr.bodyHash.length !== 32 ||
                  hdr.opCert.hotVKey.length !== 32 ||
                  hdr.opCert.sigma.length !== 64
                ) {
                  if (failures.length < MAX_FAILURES)
                    failures.push(`chunk ${chunkNo}, slot ${slotNo}: invalid header field lengths`);
                }
              }
            } catch (e) {
              if (failures.length < MAX_FAILURES)
                failures.push(`chunk ${chunkNo}, slot ${slotNo}: ${e}`);
            }
          }

          if ((chunkNo + 1) % 500 === 0) {
            yield* Effect.log(
              `processed ${chunkNo + 1}/${totalChunks} chunks, ${totalBlocks} blocks`,
            );
          }
        }

        yield* Effect.log(
          `ALL ${totalChunks} chunks: ${totalBlocks} blocks ` +
            `(${byronBlocks} Byron, ${postByronBlocks} post-Byron), ` +
            `${totalTxBodies} tx bodies, ${headersDecoded} headers decoded`,
        );

        if (failures.length > 0) {
          yield* Effect.log(`FAILURES (${failures.length}):`);
          for (const f of failures) yield* Effect.log(`  ${f}`);
        }

        assert.strictEqual(failures.length, 0, `Decode failures:\n${failures.join("\n")}`);
        assert.isTrue(totalBlocks > 0);
        assert.isTrue(postByronBlocks > 0);
        assert.isTrue(headersDecoded > 0);
        assert.isTrue(totalTxBodies > 0);
      }),
    { timeout: 600_000 },
  );

  it.effect(
    "decodes the full NewEpochState from the state file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bytes = yield* fs.readFile(STATE_PATH);
        const ext = yield* decodeExtLedgerState(new Uint8Array(bytes));

        assert.isDefined(ext.newEpochState);
        assert.isTrue(ext.newEpochState.epoch > 0n);
        assert.isTrue(ext.newEpochState.blocksMadePrev.size > 0);

        const es = ext.newEpochState.epochState;
        assert.isTrue(es.chainAccountState.treasury > 0n);

        const cert = es.ledgerState.certState;
        assert.isTrue(cert.vState.dreps.size > 0);
        assert.isTrue(cert.pState.stakePools.size > 0);

        assert.isTrue(ext.newEpochState.poolDistr.pools.size > 0);
        assert.strictEqual(ext.pastEras.length, 6);
        assert.isDefined(ext.newEpochState.stashedAVVMAddresses);
        assert.isDefined(ext.chainDepState);

        yield* Effect.log(
          `State: epoch ${ext.newEpochState.epoch}, ` +
            `${ext.newEpochState.poolDistr.pools.size} pools, ` +
            `${cert.vState.dreps.size} DReps`,
        );
      }).pipe(Effect.provide(FsLayer)),
    { timeout: 60_000 },
  );
});
