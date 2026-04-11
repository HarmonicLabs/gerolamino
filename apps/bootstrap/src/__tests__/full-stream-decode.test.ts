/**
 * Full E2E test: start bootstrap server, stream the entire Mithril snapshot
 * via WebSocket client, and decode every block with the ledger package.
 */
import { describe, it, assert } from "@effect/vitest";
import { Effect, Layer, Stream, Ref } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { initLmdb } from "../lmdb.ts";
import { readSnapshotMeta, bootstrapStream } from "../loader.ts";
import { MessageTag, decodeFrame, type BlockMessage } from "bootstrap";
import { decodeMultiEraBlock } from "ledger";

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

describe("Full snapshot stream + decode", () => {
  it.effect(
    "streams entire snapshot and decodes all blocks with zero failures",
    () =>
      Effect.gen(function* () {
        yield* initLmdb;

        const meta = yield* readSnapshotMeta("./db");
        yield* Effect.log(
          `Snapshot: magic=${meta.protocolMagic} slot=${meta.snapshotSlot} chunks=${meta.totalChunks}`,
        );

        const totalBlocks = yield* Ref.make(0);
        const totalTxs = yield* Ref.make(0);
        const failures = yield* Ref.make(0);
        const totalLmdbEntries = yield* Ref.make(0);
        let lastLoggedBlocks = 0;

        yield* bootstrapStream(meta).pipe(
          Stream.mapEffect((frame) =>
            Effect.gen(function* () {
              const msg = decodeFrame(frame);

              switch (msg.tag) {
                case MessageTag.Block: {
                  // After narrowing on msg.tag, msg is BlockMessage
                  const block = msg;
                  const result = yield* decodeMultiEraBlock(block.blockCbor).pipe(
                    Effect.map((decoded) => {
                      const txCount = decoded._tag === "postByron" ? decoded.txBodies.length : 0;
                      return { ok: true as const, txCount };
                    }),
                    Effect.catch(() => Effect.succeed({ ok: false as const, txCount: 0 })),
                  );

                  if (result.ok) {
                    yield* Ref.update(totalBlocks, (n) => n + 1);
                    yield* Ref.update(totalTxs, (n) => n + result.txCount);
                  } else {
                    yield* Ref.update(failures, (n) => n + 1);
                  }

                  const currentBlocks = yield* Ref.get(totalBlocks);
                  if (currentBlocks - lastLoggedBlocks >= 500_000) {
                    lastLoggedBlocks = currentBlocks;
                    const currentTxs = yield* Ref.get(totalTxs);
                    const currentFailures = yield* Ref.get(failures);
                    yield* Effect.log(
                      `Progress: ${currentBlocks} blocks, ${currentTxs} txs, ${currentFailures} failures`,
                    );
                  }
                  break;
                }
                case MessageTag.LmdbEntries: {
                  yield* Ref.update(totalLmdbEntries, (n) => n + msg.count);
                  break;
                }
                case MessageTag.Init:
                  yield* Effect.log(`Init: magic=${msg.protocolMagic} chunks=${msg.totalChunks}`);
                  break;
                case MessageTag.LedgerState:
                  yield* Effect.log(`LedgerState: ${msg.payload.length} bytes`);
                  break;
                case MessageTag.LedgerMeta:
                  yield* Effect.log(`LedgerMeta: ${new TextDecoder().decode(msg.payload)}`);
                  break;
                case MessageTag.Complete:
                  yield* Effect.log("Stream complete");
                  break;
              }
            }),
          ),
          Stream.runDrain,
        );

        const finalBlocks = yield* Ref.get(totalBlocks);
        const finalTxs = yield* Ref.get(totalTxs);
        const finalFailures = yield* Ref.get(failures);
        const finalLmdb = yield* Ref.get(totalLmdbEntries);

        yield* Effect.log(
          `\nFinal: ${finalBlocks} blocks, ${finalTxs} txs, ${finalLmdb} LMDB entries, ${finalFailures} failures`,
        );

        assert.strictEqual(finalFailures, 0, `Expected 0 decode failures, got ${finalFailures}`);
        assert.isTrue(finalBlocks > 0, "Expected at least one block");
      }).pipe(Effect.provide(platform)),
    { timeout: 600_000 },
  );
});
