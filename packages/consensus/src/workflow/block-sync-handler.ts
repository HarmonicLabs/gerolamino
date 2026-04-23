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
      execute: Effect.gen(function* () {
        let processed = 0;
        while (processed < 3) {
          const slot = payload.fromSlot + BigInt(processed + 1);
          const hash = new Uint8Array(32).fill((processed + 1) & 0xff);
          const parentHash =
            processed === 0
              ? new Uint8Array(32)
              : new Uint8Array(32).fill(processed & 0xff);

          yield* writeChainEvent({
            _tag: "BlockAccepted",
            slot,
            blockNo: slot,
            hash,
            parentHash,
          });
          yield* writeChainEvent({
            _tag: "TipAdvanced",
            slot,
            blockNo: slot,
            hash,
          });

          processed += 1;
        }
        return processed;
      }),
    });

    const finalSlot = payload.fromSlot + BigInt(blocksProcessed);
    return BlockSyncSuccess.make({
      tipSlot: finalSlot,
      tipHash: new Uint8Array(32).fill(blocksProcessed & 0xff),
      blocksProcessed,
    });
  }),
);
