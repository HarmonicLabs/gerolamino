/**
 * Chain sync pipeline — connects bootstrap data to the consensus layer.
 *
 * The sync pipeline:
 * 1. Load snapshot tip from LedgerDB
 * 2. Apply incoming blocks via ConsensusEngine.validateHeader
 * 3. Store validated blocks in ImmutableDB/VolatileDB
 * 4. Track sync progress via GSM state machine
 * 5. Evolve nonces per block
 */
import { Effect, Stream, Schema } from "effect";
import type { StoredBlock, RealPoint } from "storage/types/StoredBlock";
import { ImmutableDB } from "storage/services/immutable-db";
import { VolatileDB } from "storage/services/volatile-db";
import { LedgerDB } from "storage/services/ledger-db";
import { ConsensusEngine } from "./consensus-engine";
import { Nonces, evolveNonce, deriveEpochNonce, isPastStabilizationWindow } from "./nonce";
import { ChainTip, gsmState } from "./chain-selection";
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

/** Cardano preprod parameters. */
const PREPROD = {
  securityParam: 2160,
  activeSlotsCoeff: 0.05,
  epochLength: 432000n,
  stabilityWindow: 129600n, // 3k/f
} as const;

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
    const immutableDb = yield* ImmutableDB;
    const volatileDb = yield* VolatileDB;

    // 1. Validate block header
    yield* engine.validateHeader(header, ledgerView);

    // 2. Store block (immutable if finalized, volatile if recent)
    // For simplicity during initial sync, treat all blocks as immutable
    yield* immutableDb.appendBlock(block);

    // 3. Evolve nonces
    const newEvolving = yield* Effect.promise(() =>
      evolveNonce(currentNonces.evolving, header.vrfOutput),
    );

    const slotInEpoch = header.slot % PREPROD.epochLength;
    const pastStabilization = isPastStabilizationWindow(
      slotInEpoch,
      PREPROD.securityParam,
      PREPROD.activeSlotsCoeff,
    );

    // Candidate nonce freezes at stabilization window
    const newCandidate = pastStabilization
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
 * Get the current sync state from storage.
 */
export const getSyncState = Effect.gen(function* () {
  const immutableDb = yield* ImmutableDB;
  const tip = yield* immutableDb.getTip;

  // Initial nonces (will be loaded from snapshot in production)
  const nonces = new Nonces({
    active: new Uint8Array(32),
    evolving: new Uint8Array(32),
    candidate: new Uint8Array(32),
    epoch: 0n,
  });

  const wallclockSlot = BigInt(Math.floor(Date.now() / 1000)); // approximate
  const tipSlot = tip?.slot ?? 0n;
  const gsm = gsmState(tipSlot, wallclockSlot, PREPROD.stabilityWindow);

  return {
    tip,
    nonces,
    gsmState: gsm,
    blocksProcessed: 0,
  } satisfies SyncState;
});

/**
 * Process a stream of blocks through the consensus pipeline.
 * Returns the final sync state after all blocks are processed.
 */
export const syncFromStream = (
  blocks: Stream.Stream<{ block: StoredBlock; header: BlockHeader; ledgerView: LedgerView }>,
) =>
  Effect.gen(function* () {
    let state = yield* getSyncState;

    yield* Stream.runForEach(blocks, ({ block, header, ledgerView }) =>
      Effect.gen(function* () {
        const newNonces = yield* processBlock(block, header, ledgerView, state.nonces);
        state = {
          ...state,
          tip: { slot: block.slot, hash: block.hash },
          nonces: newNonces,
          blocksProcessed: state.blocksProcessed + 1,
          gsmState: gsmState(block.slot, BigInt(Math.floor(Date.now() / 1000)), PREPROD.stabilityWindow),
        };
        if (state.blocksProcessed % 10000 === 0) {
          yield* Effect.log(`Synced ${state.blocksProcessed} blocks, tip slot ${block.slot}`);
        }
      }),
    );

    return state;
  });
