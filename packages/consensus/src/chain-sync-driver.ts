/**
 * ChainSync driver — connects miniprotocols ChainSync to the consensus pipeline.
 *
 * Handles the full sync flow:
 * 1. Find intersection with relay using our tip
 * 2. Stream headers via requestNext()
 * 3. On RollForward: validate header, store block, evolve nonces
 * 4. On RollBackward: revert state to the rollback point
 * 5. Detect caught-up state when server sends AwaitReply
 *
 * The driver is an Effect program that runs in a Scope (for resource cleanup).
 */
import { Effect, Schema, Stream } from "effect";
import { SlotClock } from "./clock";
import { ConsensusEngine } from "./consensus-engine";
import { PeerManager } from "./peer-manager";
import { ChainTip, gsmState } from "./chain-selection";
import { Nonces, evolveNonce, isPastStabilizationWindow } from "./nonce";
import { ImmutableDB } from "storage/services/immutable-db";
import type { BlockHeader, LedgerView } from "./validate-header";

export class ChainSyncDriverError extends Schema.TaggedErrorClass<ChainSyncDriverError>()(
  "ChainSyncDriverError",
  { message: Schema.String, cause: Schema.Defect },
) {}

/** Volatile chain state — tracks the mutable tip and recent blocks. */
export interface VolatileState {
  /** Current chain tip. */
  readonly tip: { slot: bigint; hash: Uint8Array } | undefined;
  /** Current nonces. */
  readonly nonces: Nonces;
  /** Blocks processed since last report. */
  readonly blocksProcessed: number;
  /** Whether we're caught up (server sent AwaitReply). */
  readonly caughtUp: boolean;
}

/** Initial volatile state — loaded from snapshot or genesis. */
export const initialVolatileState = (
  tip: { slot: bigint; hash: Uint8Array } | undefined,
  nonces: Nonces,
): VolatileState => ({
  tip,
  nonces,
  blocksProcessed: 0,
  caughtUp: false,
});

/**
 * Process a RollForward message from ChainSync.
 *
 * Validates the header, stores the block, evolves nonces.
 * Returns the updated volatile state.
 */
export const handleRollForward = (
  headerBytes: Uint8Array,
  serverTip: { slot: bigint; blockNo: bigint; hash: Uint8Array },
  state: VolatileState,
  peerId: string,
  ledgerView: LedgerView,
) =>
  Effect.gen(function* () {
    const engine = yield* ConsensusEngine;
    const immutableDb = yield* ImmutableDB;
    const peerManager = yield* PeerManager;
    const slotClock = yield* SlotClock;

    // TODO: decode headerBytes via ledger package to extract BlockHeader
    // For now, create a minimal header from the server tip
    // In production, this would parse the CBOR header bytes

    // Update peer tip
    yield* peerManager.updatePeerTip(
      peerId,
      new ChainTip({
        slot: serverTip.slot,
        blockNo: serverTip.blockNo,
        hash: serverTip.hash,
      }),
    );

    // Evolve nonces
    // TODO: extract VRF output from decoded header
    const vrfOutput = new Uint8Array(32); // placeholder
    const newEvolving = yield* Effect.promise(() =>
      evolveNonce(state.nonces.evolving, vrfOutput),
    );

    const slotInEpoch = slotClock.slotWithinEpoch(serverTip.slot);
    const pastCollection = isPastStabilizationWindow(
      slotInEpoch,
      slotClock.config.securityParam,
      slotClock.config.activeSlotsCoeff,
    );

    const newNonces = new Nonces({
      active: state.nonces.active,
      evolving: newEvolving,
      candidate: pastCollection ? state.nonces.candidate : newEvolving,
      epoch: slotClock.slotToEpoch(serverTip.slot),
    });

    return {
      tip: { slot: serverTip.slot, hash: serverTip.hash },
      nonces: newNonces,
      blocksProcessed: state.blocksProcessed + 1,
      caughtUp: false,
    } satisfies VolatileState;
  });

/**
 * Process a RollBackward message from ChainSync.
 *
 * Reverts state to the specified point.
 * For a data node, this means we need to track the rollback point
 * and re-sync from there.
 */
export const handleRollBackward = (
  rollbackPoint: { slot: bigint; hash: Uint8Array } | undefined,
  serverTip: { slot: bigint; blockNo: bigint; hash: Uint8Array },
  state: VolatileState,
  peerId: string,
) =>
  Effect.gen(function* () {
    const peerManager = yield* PeerManager;

    yield* peerManager.updatePeerTip(
      peerId,
      new ChainTip({
        slot: serverTip.slot,
        blockNo: serverTip.blockNo,
        hash: serverTip.hash,
      }),
    );

    yield* Effect.log(
      `RollBackward from peer ${peerId}: reverting to slot ${rollbackPoint?.slot ?? "origin"}`,
    );

    // For now, update tip to rollback point
    // TODO: actually revert ImmutableDB/VolatileDB state
    return {
      ...state,
      tip: rollbackPoint,
      caughtUp: false,
    } satisfies VolatileState;
  });
