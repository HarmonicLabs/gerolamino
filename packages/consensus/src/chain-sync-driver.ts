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
import { Nonces, evolveNonce, deriveEpochNonce, isPastStabilizationWindow } from "./nonce";
import { decodeAndBridge } from "./header-bridge";
import { ChainDB } from "storage/services/chain-db";
import { verifyBodyHash } from "./validate-block";
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
    const peerManager = yield* PeerManager;
    const slotClock = yield* SlotClock;
    const chainDb = yield* ChainDB;

    // Decode CBOR block bytes via ledger → consensus header bridge.
    // If decode fails (Byron, invalid CBOR), treat as opaque block — store and skip validation.
    const decoded = yield* Effect.orElseSucceed(
      decodeAndBridge(headerBytes, serverTip.hash),
      () => undefined,
    );

    // Update peer tip
    yield* peerManager.updatePeerTip(
      peerId,
      new ChainTip({
        slot: serverTip.slot,
        blockNo: serverTip.blockNo,
        hash: serverTip.hash,
      }),
    );

    // Byron blocks skip consensus validation — just store and advance
    if (decoded === undefined) {
      yield* chainDb.addBlock({
        slot: serverTip.slot,
        hash: serverTip.hash,
        prevHash: undefined,
        blockNo: serverTip.blockNo,
        blockSizeBytes: headerBytes.byteLength,
        blockCbor: headerBytes,
      });
      return {
        tip: { slot: serverTip.slot, hash: serverTip.hash },
        nonces: state.nonces,
        blocksProcessed: state.blocksProcessed + 1,
        caughtUp: false,
      } satisfies VolatileState;
    }

    // Validate header + body hash integrity (parallel)
    yield* Effect.all([
      engine.validateHeader(decoded.header, ledgerView),
      verifyBodyHash(headerBytes, decoded.header.bodyHash),
    ]);

    // Store block in ChainDB
    yield* chainDb.addBlock({
      slot: decoded.header.slot,
      hash: decoded.header.hash,
      prevHash: decoded.header.prevHash,
      blockNo: decoded.header.blockNo,
      blockSizeBytes: headerBytes.byteLength,
      blockCbor: headerBytes,
    });

    // Epoch transition — derive new epoch nonce at boundary
    const blockEpoch = slotClock.slotToEpoch(serverTip.slot);
    let nonces = state.nonces;

    if (blockEpoch > state.nonces.epoch) {
      const newEpochNonce = deriveEpochNonce(
        state.nonces.candidate,
        decoded.header.prevHash,
      );
      nonces = new Nonces({
        active: newEpochNonce,
        evolving: newEpochNonce,
        candidate: newEpochNonce,
        epoch: blockEpoch,
      });
    }

    // Evolve nonces using VRF output from decoded header
    const newEvolving = evolveNonce(nonces.evolving, decoded.header.vrfOutput);

    const slotInEpoch = slotClock.slotWithinEpoch(serverTip.slot);
    const pastCollection = isPastStabilizationWindow(
      slotInEpoch,
      slotClock.config.securityParam,
      slotClock.config.activeSlotsCoeff,
    );

    const newNonces = new Nonces({
      active: nonces.active,
      evolving: newEvolving,
      candidate: pastCollection ? nonces.candidate : newEvolving,
      epoch: blockEpoch,
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
    const chainDb = yield* ChainDB;

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

    // Rollback ChainDB volatile state to the rollback point
    if (rollbackPoint) {
      yield* chainDb.rollback(rollbackPoint);
    }

    return {
      ...state,
      tip: rollbackPoint,
      caughtUp: false,
    } satisfies VolatileState;
  });
