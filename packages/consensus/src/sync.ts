/**
 * Chain sync pipeline — connects bootstrap data to the consensus layer.
 *
 * Uses SlotClock for time → slot mapping (configurable via Effect Config).
 * All parameters read from SlotClock.config (no hardcoded values).
 *
 * Pipeline:
 * 1. Load snapshot tip from ImmutableDB
 * 2. Validate incoming block headers via ConsensusEngine
 * 3. Store validated blocks in ImmutableDB
 * 4. Evolve nonces per block (with correct VRF tag bytes)
 * 5. Track sync progress via GSM state
 */
import { Effect, Stream, Schema } from "effect";
import type { StoredBlock, RealPoint } from "storage/types/StoredBlock";
import { ChainDB } from "storage/services/chain-db";
import { ConsensusEngine } from "./consensus-engine";
import { Nonces, evolveNonce, isPastStabilizationWindow } from "./nonce";
import { gsmState } from "./chain-selection";
import { SlotClock } from "./clock";
import type { BlockHeader, LedgerView } from "./validate-header";
import type { GsmState } from "./chain-selection";

export class SyncError extends Schema.TaggedErrorClass<SyncError>()(
  "SyncError",
  { message: Schema.String, cause: Schema.Defect },
) {}

export interface SyncState {
  readonly tip: RealPoint | undefined;
  readonly nonces: Nonces;
  readonly gsmState: GsmState;
  readonly blocksProcessed: number;
}

/**
 * Process a single block through the consensus pipeline.
 * Validates header, stores block, evolves nonces.
 */
export const processBlock = (
  block: StoredBlock,
  header: BlockHeader,
  ledgerView: LedgerView,
  currentNonces: Nonces,
) =>
  Effect.gen(function* () {
    const engine = yield* ConsensusEngine;
    const chainDb = yield* ChainDB;
    const slotClock = yield* SlotClock;

    // 1. Validate block header
    yield* engine.validateHeader(header, ledgerView);

    // 2. Store block in ChainDB (volatile)
    yield* chainDb.addBlock(block);

    // 3. Evolve nonces using VRF nonce output
    const newEvolving = evolveNonce(currentNonces.evolving, header.vrfOutput);

    // 4. Check if past candidate collection period (16k/f)
    const slotInEpoch = slotClock.slotWithinEpoch(header.slot);
    const pastCollection = isPastStabilizationWindow(
      slotInEpoch,
      slotClock.config.securityParam,
      slotClock.config.activeSlotsCoeff,
    );

    // Candidate nonce freezes at 16k/f — only update if still collecting
    const newCandidate = pastCollection
      ? currentNonces.candidate
      : newEvolving;

    return new Nonces({
      active: currentNonces.active,
      evolving: newEvolving,
      candidate: newCandidate,
      epoch: currentNonces.epoch,
    });
  });

/**
 * Get the current sync state from storage + clock.
 */
export const getSyncState = Effect.gen(function* () {
  const chainDb = yield* ChainDB;
  const slotClock = yield* SlotClock;

  const tip = yield* chainDb.getTip;

  const nonces = new Nonces({
    active: new Uint8Array(32),
    evolving: new Uint8Array(32),
    candidate: new Uint8Array(32),
    epoch: 0n,
  });

  const wallclockSlot = yield* slotClock.currentSlot;
  const tipSlot = tip?.slot ?? 0n;
  const gsm = gsmState(tipSlot, wallclockSlot, slotClock.stabilityWindow);

  return {
    tip,
    nonces,
    gsmState: gsm,
    blocksProcessed: 0,
  } satisfies SyncState;
});

/**
 * Process a stream of blocks through the consensus pipeline.
 */
export const syncFromStream = (
  blocks: Stream.Stream<{ block: StoredBlock; header: BlockHeader; ledgerView: LedgerView }>,
) =>
  Effect.gen(function* () {
    const slotClock = yield* SlotClock;
    let state = yield* getSyncState;

    yield* Stream.runForEach(blocks, ({ block, header, ledgerView }) =>
      Effect.gen(function* () {
        const newNonces = yield* processBlock(block, header, ledgerView, state.nonces);
        const wallclockSlot = yield* slotClock.currentSlot;
        state = {
          ...state,
          tip: { slot: block.slot, hash: block.hash },
          nonces: newNonces,
          blocksProcessed: state.blocksProcessed + 1,
          gsmState: gsmState(block.slot, wallclockSlot, slotClock.stabilityWindow),
        };
        if (state.blocksProcessed % 10000 === 0) {
          yield* Effect.log(`Synced ${state.blocksProcessed} blocks, tip slot ${block.slot}`);
        }
      }),
    );

    return state;
  });
