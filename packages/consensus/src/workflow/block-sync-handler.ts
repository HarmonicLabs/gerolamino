/**
 * BlockSync Workflow handler layer.
 *
 * Phase 3f proper: composes the orchestration shape for genesis→tip sync.
 * Per wave-2 Correction #9 ("ChainDB internal worker is sequential, not
 * a pipelined stage-DAG"): the Workflow orchestrates while the actual
 * per-peer ChainSync + BlockFetch fibers run CONCURRENTLY, publishing
 * into ChainDb's internal validator (sequential per Haskell). Our
 * SyncStage pipelining is a gerolamino-native architectural choice,
 * safe because LedgerApplyStage remains single-fiber.
 *
 * This file ships a scaffolding handler that exercises the full
 * distributed-system integration shape:
 *   - Activities with durable caching (keyed by
 *     `(executionId, name, attempt)`)
 *   - Writing `ChainEvent`s through the shared `EventLog` so downstream
 *     subscribers (Mempool rollback daemon, dashboard Atoms, TUI RPC
 *     stream) see workflow progress as durable events
 *
 * Consumers provide concrete per-peer sync via a layer swap once Phase
 * 2e Peer Cluster Entity + Phase 3c ChainDb worker fiber land.
 *
 * Activity-result caching: per `WorkflowEngine` semantics, each named
 * Activity caches its result keyed by `(executionId, name, attempt)`.
 * On workflow resume, `DiscoverPeers` short-circuits rather than
 * re-running. This is why Activities carry `name: "..."` — the cache
 * key is the name.
 */
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import { writeChainEvent } from "../chain/event-log.ts";
import { BlockSyncSuccess, BlockSyncWorkflow } from "./block-sync.ts";

/**
 * Requires `WorkflowEngine` (provided by `WorkflowEngine.layerMemory` in
 * apps/tui, or a sqlite-backed adapter in apps/bootstrap) + `EventLog`
 * (for `writeChainEvent` — the BlockSync handler emits `BlockAccepted` +
 * `TipAdvanced` events that downstream subscribers observe).
 */
export const BlockSyncHandlerLive = BlockSyncWorkflow.toLayer(
  Effect.fn("BlockSyncWorkflow.handle")(function* (payload) {
    yield* Effect.log(
      `BlockSync: starting chain=${payload.chainId} fromSlot=${payload.fromSlot}`,
    );

    // Activity 1 — DiscoverPeers. Cached on first success; resume
    // short-circuits. Stub returns a synthetic peer count; real handler
    // connects to `PeerRegistry` (Phase 2e) + walks bootstrap seeds.
    const peerCount = yield* Activity.make({
      name: "DiscoverPeers",
      success: Schema.Number,
      execute: Effect.succeed(3),
    });
    yield* Effect.log(`DiscoverPeers: found ${peerCount} peers`);

    // Activity 2 — StartSyncLoop. Stub emits three synthetic
    // `BlockAccepted` + `TipAdvanced` pairs through the `EventLog` so
    // subscribers (Mempool daemon, dashboard Atoms, TUI RPC stream)
    // observe the full end-to-end integration. Real handler spawns
    // per-peer ChainSync fibers + dispatches into ChainDb's sequential
    // validator; the `writeChainEvent` call site moves but the contract
    // stays the same.
    const blocksProcessed = yield* Activity.make({
      name: "StartSyncLoop",
      success: Schema.Number,
      // Emit three synthetic (BlockAccepted, TipAdvanced) pairs over the
      // EventLog. `Effect.forEach(Array.from({length: 3}, …))` replaces
      // the mutable-counter `while` loop; `discard: true` avoids
      // allocating a result array we'd immediately throw away.
      //
      // Journal-write failures are infra defects (backing `EventJournal`
      // is memory or sqlite; an error here means disk/IPC broke).
      // `Effect.orDie` keeps the Activity's declared `error: never`
      // contract stable without paper-over by adding a dummy error
      // schema to the Activity definition.
      execute: Effect.as(
        Effect.forEach(
          Array.from({ length: 3 }, (_, i) => i),
          (i) => {
            const slot = payload.fromSlot + BigInt(i + 1);
            const hash = new Uint8Array(32).fill((i + 1) & 0xff);
            const parentHash =
              i === 0 ? new Uint8Array(32) : new Uint8Array(32).fill(i & 0xff);
            return Effect.all(
              [
                writeChainEvent({
                  _tag: "BlockAccepted",
                  slot,
                  blockNo: slot,
                  hash,
                  parentHash,
                }),
                writeChainEvent({ _tag: "TipAdvanced", slot, blockNo: slot, hash }),
              ],
              { discard: true },
            ).pipe(Effect.orDie);
          },
          { discard: true },
        ),
        3,
      ),
    });

    const finalSlot = payload.fromSlot + BigInt(blocksProcessed);
    return BlockSyncSuccess.make({
      tipSlot: finalSlot,
      tipHash: new Uint8Array(32).fill(blocksProcessed & 0xff),
      blocksProcessed,
    });
  }),
);
