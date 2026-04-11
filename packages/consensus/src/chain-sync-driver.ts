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
import { Deferred, Effect, HashMap, Ref, Schema } from "effect";
import { SlotClock } from "./clock";
import { ConsensusEngine } from "./consensus-engine";
import { PeerManager } from "./peer-manager";
import { ChainTip } from "./chain-selection";
import { Nonces, evolveNonce, deriveEpochNonce, isPastStabilizationWindow } from "./nonce";
import { decodeWrappedHeader, DecodedHeader } from "./header-bridge";
import { ChainDB } from "storage";
import type { BlockHeader, LedgerView } from "./validate-header";

export class ChainSyncDriverError extends Schema.TaggedErrorClass<ChainSyncDriverError>()(
  "ChainSyncDriverError",
  { message: Schema.String, cause: Schema.Defect },
) {}

/** Volatile chain state — tracks the mutable tip and recent blocks. */
export const VolatileState = Schema.Struct({
  tip: Schema.optional(Schema.Struct({ slot: Schema.BigInt, hash: Schema.Uint8Array })),
  nonces: Nonces,
  blocksProcessed: Schema.Number,
  caughtUp: Schema.Boolean,
});
export type VolatileState = typeof VolatileState.Type;

/** Initial volatile state — loaded from snapshot or genesis. */
export const initialVolatileState = (
  tip: { slot: bigint; hash: Uint8Array } | undefined,
  nonces: Nonces,
): VolatileState => {
  const result: VolatileState = {
    tip,
    nonces,
    blocksProcessed: 0,
    caughtUp: false,
  };
  return result;
};

/**
 * Process a RollForward message from ChainSync.
 *
 * For Shelley+: validates the header (5 Praos assertions), stores the block, evolves nonces.
 * For Byron: stores the block and updates tip — no Praos validation or nonce evolution.
 * Returns the updated volatile state.
 */
export const handleRollForward = (
  headerBytes: Uint8Array,
  eraVariant: number,
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

    // Update peer tip (server's chain tip, not this block)
    yield* peerManager.updatePeerTip(
      peerId,
      new ChainTip({
        slot: serverTip.slot,
        blockNo: serverTip.blockNo,
        hash: serverTip.hash,
      }),
    );

    // Decode N2N ChainSync header — returns Byron or Shelley info
    const decoded = yield* decodeWrappedHeader(headerBytes, eraVariant);

    if (DecodedHeader.guards.byron(decoded)) {
      // Byron blocks: store in ChainDB, update tip. No Praos validation or nonce evolution.
      yield* chainDb.addBlock({
        slot: decoded.slot,
        hash: decoded.hash,
        prevHash: decoded.prevHash,
        blockNo: decoded.blockNo,
        blockSizeBytes: headerBytes.byteLength,
        blockCbor: headerBytes,
      });

      const result: VolatileState = {
        tip: { slot: decoded.slot, hash: decoded.hash },
        nonces: state.nonces,
        blocksProcessed: state.blocksProcessed + 1,
        caughtUp: false,
      };
      return result;
    }

    // Shelley+ path: Praos validation (if pools available) + nonce evolution
    const header = decoded.header;

    // Skip Praos validation when LedgerView has no pools (genesis sync mode).
    // Byron blocks already skip validation above; this handles Shelley+ blocks
    // during genesis sync where no bootstrap data provides pool distributions.
    if (HashMap.size(ledgerView.poolVrfKeys) > 0) {
      yield* engine.validateHeader(header, ledgerView);
    }

    // Storage and nonce evolution are INDEPENDENT — run in parallel.
    // Storage writes to DB; nonce computation reads only header fields.
    const [, newNonces] = yield* Effect.all([
      // I/O-bound: store block metadata + header bytes in ChainDB
      chainDb.addBlock({
        slot: header.slot,
        hash: header.hash,
        prevHash: header.prevHash,
        blockNo: header.blockNo,
        blockSizeBytes: headerBytes.byteLength,
        blockCbor: headerBytes,
      }),
      // CPU-bound (fast): compute nonces purely from header fields
      Effect.sync(() => {
        const blockEpoch = slotClock.slotToEpoch(header.slot);
        let nonces = state.nonces;

        if (blockEpoch > state.nonces.epoch) {
          const newEpochNonce = deriveEpochNonce(
            state.nonces.candidate,
            header.prevHash,
          );
          nonces = new Nonces({
            active: newEpochNonce,
            evolving: newEpochNonce,
            candidate: newEpochNonce,
            epoch: blockEpoch,
          });
        }

        const newEvolving = evolveNonce(nonces.evolving, header.nonceVrfOutput);
        const slotInEpoch = slotClock.slotWithinEpoch(header.slot);
        const pastCollection = isPastStabilizationWindow(
          slotInEpoch,
          slotClock.config.securityParam,
          slotClock.config.activeSlotsCoeff,
          slotClock.config.epochLength,
        );

        return new Nonces({
          active: nonces.active,
          evolving: newEvolving,
          candidate: pastCollection ? nonces.candidate : newEvolving,
          epoch: blockEpoch,
        });
      }),
    ], { concurrency: "unbounded" });

    const result: VolatileState = {
      tip: { slot: header.slot, hash: header.hash },
      nonces: newNonces,
      blocksProcessed: state.blocksProcessed + 1,
      caughtUp: false,
    };
    return result;
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

    const result: VolatileState = {
      ...state,
      tip: rollbackPoint,
      caughtUp: false,
    };
    return result;
  });
