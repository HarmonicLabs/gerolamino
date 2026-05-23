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
import { Effect, Option, Ref, Schedule, Schema } from "effect";
import { clamp } from "es-toolkit";
import { SlotClock } from "./praos/clock";
import { PeerManager } from "./peer/manager";
import { ConsensusEvents, ConsensusEventKind } from "./peer/events";
import { ChainDB } from "storage";
import { GsmState, gsmState } from "./chain/selection";
import type { VolatileState } from "./sync/driver";

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
 * Pass a `volatileStateRef` to read live blocksProcessed from the sync loop.
 */
export const getNodeStatus = (volatileStateRef?: Ref.Ref<VolatileState>) =>
  Effect.gen(function* () {
    const slotClock = yield* SlotClock;
    const peerManager = yield* PeerManager;
    const chainDb = yield* ChainDB;

    const tipOpt = yield* chainDb.getTip;
    const currentSlot = yield* slotClock.currentSlot;
    const epoch = yield* slotClock.currentEpoch;
    // O(1) read from the cached active-peer Ref instead of a full
    // `getPeers().filter(...).length` walk — peer-manager maintains this
    // counter atomically with add/remove.
    const activePeers = yield* peerManager.getActiveCount;

    let tipSlot = Option.isSome(tipOpt) ? tipOpt.value.slot : 0n;
    const tipBlock = Option.isSome(tipOpt)
      ? yield* chainDb.getBlockAt(tipOpt.value)
      : Option.none();
    let tipBlockNo = Option.isSome(tipBlock) ? tipBlock.value.blockNo : 0n;

    // While ChainDB writes are still failing (e.g. browser LSM warmup),
    // reflect the upstream relay tip from PeerManager so the dashboard
    // and E2E harness see live sync progress.
    if (tipSlot === 0n) {
      const peers = yield* peerManager.getPeers;
      for (const peer of peers) {
        if (peer.tip !== undefined && peer.tip.slot > tipSlot) {
          tipSlot = peer.tip.slot;
          tipBlockNo = peer.tip.blockNo;
        }
      }
    }
    // Sync ratio as a percentage of historical chain coverage. Computed
    // in 1000-ths so a sub-1% genesis-mode sync (typical at startup) shows
    // a non-zero value instead of integer-truncating to 0. `clamp` bounds
    // both sides — a negative `syncPercent` would surface if a clock skew
    // put the wallclock behind the tip, which is impossible-but-cheap to
    // guard.
    const syncPermille = currentSlot > 0n ? Number((tipSlot * 100000n) / currentSlot) : 0;
    const syncPercent = clamp(syncPermille / 1000, 0, 100);

    const blocksProcessed = volatileStateRef
      ? (yield* Ref.get(volatileStateRef)).blocksProcessed
      : 0;

    const result: NodeStatus = {
      tipSlot,
      tipBlockNo,
      currentSlot,
      epochNumber: epoch,
      gsmState: gsmState(tipSlot, currentSlot, slotClock.stabilityWindow),
      peerCount: activePeers,
      blocksProcessed,
      syncPercent,
    };
    return result;
  });

/**
 * One iteration of the monitor loop. Extracted from `monitorLoop` so the
 * outer `Effect.repeat` reads as a single composition step (audit F18).
 *
 * - Reads node status + detects stalled peers
 * - Emits `PeerStalled` events (one per stalled peer id)
 * - Emits `GsmTransition` only when the GSM state changed since the
 *   prior tick — `lastGsmState` is the cross-tick handshake
 * - Logs a one-line status summary
 */
const monitorTick = (
  peerManager: PeerManager["Service"],
  events: Option.Option<ConsensusEvents["Service"]>,
  lastGsmState: Ref.Ref<string | undefined>,
) =>
  Effect.gen(function* () {
    const status = yield* getNodeStatus();
    const stalled = yield* peerManager.detectStalls;

    // Emit PeerStalled events
    if (stalled.length > 0) {
      yield* Effect.log(`Detected ${stalled.length} stalled peers: ${stalled.join(", ")}`);
      if (Option.isSome(events)) {
        yield* Effect.forEach(
          stalled,
          (peerId) => events.value.emit({ _tag: ConsensusEventKind.PeerStalled, peerId }),
          { discard: true },
        );
      }
    }

    // Emit GsmTransition event on state change.
    const prevGsmState = yield* Ref.get(lastGsmState);
    if (prevGsmState !== undefined && prevGsmState !== status.gsmState && Option.isSome(events)) {
      yield* events.value.emit({
        _tag: ConsensusEventKind.GsmTransition,
        from: prevGsmState,
        to: status.gsmState,
      });
    }
    yield* Ref.set(lastGsmState, status.gsmState);

    yield* Effect.log(
      `[${status.gsmState}] slot ${status.tipSlot}/${status.currentSlot} ` +
        `(${status.syncPercent}%) epoch ${status.epochNumber} peers ${status.peerCount}`,
    );
  });

/**
 * Run the node's monitoring loop — periodic status logging and stall detection.
 * Runs forever until interrupted.
 */
export const monitorLoop = Effect.gen(function* () {
  const peerManager = yield* PeerManager;
  const events = yield* Effect.serviceOption(ConsensusEvents);
  // Cross-iteration state held in a `Ref` — Effect-abstraction equivalent
  // of the old `let lastGsmState`; survives fiber suspension (e.g.,
  // `Effect.repeat` sleeping between ticks) and remains observable by
  // future subscribers if the monitor ever needs one.
  const lastGsmState = yield* Ref.make<string | undefined>(undefined);

  yield* Effect.repeat(
    monitorTick(peerManager, events, lastGsmState).pipe(
      // Individual monitor iterations are non-fatal — log and continue
      Effect.catch((e) => Effect.logWarning(`Monitor check failed: ${e}`)),
    ),
    // `spaced` over `fixed`: we want 10 s of idle time *between* checks, not
    // a fixed 10 s wallclock period. If a status read takes 8 s (slow chainDB
    // tip read on a cold start), `fixed` would only give the next iteration
    // 2 s of breathing room before kicking off again; `spaced` always sleeps
    // a full 10 s after completion. This is the canonical monitor-loop idiom.
    Schedule.spaced("10 seconds"),
  );
});
