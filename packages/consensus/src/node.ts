/**
 * Node orchestrator — ties consensus services together into a running node.
 *
 * Architecture (Amaru-inspired 5-stage pipeline as Effect composition):
 * 1. Bootstrap: load snapshot, initialize ledger state
 * 2. Connect: establish N2N connections to relay peers
 * 3. Sync: ChainSync headers → validate → store → evolve nonces
 * 4. Monitor: track GSM state, detect stalls, log progress
 *
 * The node is a single Effect program that composes services via layers.
 * No XState needed — Effect's structured concurrency handles lifecycle.
 */
import { Effect, Option, Schedule, Schema } from "effect";
import { SlotClock } from "./clock";
import { ConsensusEngine } from "./consensus-engine";
import { PeerManager } from "./peer-manager";
import { getSyncState } from "./sync";
import { ChainDB } from "storage";
import { GsmState } from "./chain-selection";

export const NodeStatus = Schema.Struct({
  tipSlot: Schema.BigInt,
  tipBlockNo: Schema.BigInt,
  currentSlot: Schema.BigInt,
  epochNumber: Schema.BigInt,
  gsmState: GsmState,
  peerCount: Schema.Number,
  blocksProcessed: Schema.Number,
  syncPercent: Schema.Number,
});
export type NodeStatus = typeof NodeStatus.Type;

/**
 * Get the current node status by reading from all services.
 */
export const getNodeStatus = Effect.gen(function* () {
  const slotClock = yield* SlotClock;
  const peerManager = yield* PeerManager;
  const chainDb = yield* ChainDB;

  const tipOpt = yield* chainDb.getTip;
  const currentSlot = yield* slotClock.currentSlot;
  const epoch = yield* slotClock.currentEpoch;
  const peers = yield* peerManager.getPeers;
  const activePeers = peers.filter((p) => p.status !== "disconnected").length;

  const tipSlot = Option.isSome(tipOpt) ? tipOpt.value.slot : 0n;
  const tipBlock = Option.isSome(tipOpt) ? yield* chainDb.getBlockAt(tipOpt.value) : Option.none();
  const tipBlockNo = Option.isSome(tipBlock) ? tipBlock.value.blockNo : 0n;
  const syncPercent = currentSlot > 0n ? Number((tipSlot * 100n) / currentSlot) : 0;

  const result: NodeStatus = {
    tipSlot,
    tipBlockNo,
    currentSlot,
    epochNumber: epoch,
    gsmState: currentSlot - tipSlot <= slotClock.stabilityWindow ? "CaughtUp" : "Syncing",
    peerCount: activePeers,
    blocksProcessed: 0,
    syncPercent: Math.min(syncPercent, 100),
  };
  return result;
});

/**
 * Run the node's monitoring loop — periodic status logging and stall detection.
 * Runs forever until interrupted.
 */
export const monitorLoop = Effect.gen(function* () {
  const peerManager = yield* PeerManager;

  yield* Effect.repeat(
    Effect.gen(function* () {
      const status = yield* getNodeStatus;
      const stalled = yield* peerManager.detectStalls;

      if (stalled.length > 0) {
        yield* Effect.log(`Detected ${stalled.length} stalled peers: ${stalled.join(", ")}`);
      }

      yield* Effect.log(
        `[${status.gsmState}] slot ${status.tipSlot}/${status.currentSlot} ` +
          `(${status.syncPercent}%) epoch ${status.epochNumber} peers ${status.peerCount}`,
      );
    }).pipe(
      // Individual monitor iterations are non-fatal — log and continue
      Effect.catch((e) => Effect.logWarning(`Monitor check failed: ${e}`)),
    ),
    Schedule.fixed("10 seconds"),
  );
});
