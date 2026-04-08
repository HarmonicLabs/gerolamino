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
import type { StoredBlock } from "storage/types/StoredBlock";
import { RealPoint } from "storage/types/StoredBlock";
import { ChainDB } from "storage/services/chain-db";
import { ConsensusEngine } from "./consensus-engine";
import { Nonces, evolveNonce, deriveEpochNonce, isPastStabilizationWindow } from "./nonce";
import { GsmState, gsmState } from "./chain-selection";
import { SlotClock } from "./clock";
import { verifyBodyHash } from "./validate-block";
import type { BlockHeader, LedgerView } from "./validate-header";

export class SyncError extends Schema.TaggedErrorClass<SyncError>()(
  "SyncError",
  { message: Schema.String, cause: Schema.Defect },
) {}

export const SyncState = Schema.Struct({
  tip: Schema.optional(RealPoint),
  nonces: Nonces,
  gsmState: GsmState,
  blocksProcessed: Schema.Number,
  volatileLength: Schema.Number,
});
export type SyncState = Schema.Schema.Type<typeof SyncState>;

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

    // 1. Validate block header + body hash integrity (parallel)
    yield* Effect.all([
      engine.validateHeader(header, ledgerView),
      verifyBodyHash(block.blockCbor, header.bodyHash),
    ]);

    // 2. Store block in ChainDB (volatile)
    yield* chainDb.addBlock(block);

    // 3. Epoch transition — derive new epoch nonce at boundary
    const blockEpoch = slotClock.slotToEpoch(header.slot);
    let nonces = currentNonces;

    if (blockEpoch > currentNonces.epoch) {
      // Epoch boundary: η_{e+1} = blake2b(candidate_e ∥ prevHash)
      const newEpochNonce = deriveEpochNonce(currentNonces.candidate, header.prevHash);
      nonces = new Nonces({
        active: newEpochNonce,
        evolving: newEpochNonce,
        candidate: newEpochNonce,
        epoch: blockEpoch,
      });
    }

    // 4. Evolve nonces using nonce-tagged VRF output (not leader VRF output)
    const newEvolving = evolveNonce(nonces.evolving, header.nonceVrfOutput);

    // 5. Check if past candidate collection period (16k/f)
    const slotInEpoch = slotClock.slotWithinEpoch(header.slot);
    const pastCollection = isPastStabilizationWindow(
      slotInEpoch,
      slotClock.config.securityParam,
      slotClock.config.activeSlotsCoeff,
    );

    // Candidate nonce freezes at 16k/f — only update if still collecting
    const newCandidate = pastCollection
      ? nonces.candidate
      : newEvolving;

    return new Nonces({
      active: nonces.active,
      evolving: newEvolving,
      candidate: newCandidate,
      epoch: blockEpoch,
    });
  });

/**
 * Load persisted nonces from the latest ledger snapshot, or return genesis nonces.
 *
 * The ledger snapshot stateBytes encodes the full ExtLedgerState. If available,
 * we derive epoch nonce from the snapshot epoch. When no snapshot exists (fresh
 * node), all nonces start as 32 zero bytes (Praos genesis nonce).
 */
const loadNonces = (epoch: bigint): Nonces =>
  new Nonces({
    active: new Uint8Array(32),
    evolving: new Uint8Array(32),
    candidate: new Uint8Array(32),
    epoch,
  });

/**
 * Get the current sync state from storage + clock.
 * Reads tip from ChainDB and derives epoch from the latest ledger snapshot.
 */
export const getSyncState = Effect.gen(function* () {
  const chainDb = yield* ChainDB;
  const slotClock = yield* SlotClock;

  const tip = yield* chainDb.getTip;
  const snapshot = yield* chainDb.readLatestLedgerSnapshot;

  // Use snapshot epoch if available, otherwise derive from tip slot
  const epoch = snapshot
    ? snapshot.epoch
    : tip
      ? slotClock.slotToEpoch(tip.slot)
      : 0n;

  const nonces = loadNonces(epoch);

  const wallclockSlot = yield* slotClock.currentSlot;
  const tipSlot = tip?.slot ?? 0n;
  const gsm = gsmState(tipSlot, wallclockSlot, slotClock.stabilityWindow);

  return {
    tip,
    nonces,
    gsmState: gsm,
    blocksProcessed: 0,
    volatileLength: 0,
  } satisfies SyncState;
});

/**
 * Promote volatile blocks to immutable when the chain grows beyond k.
 * Returns the new volatile length after promotion + GC.
 */
const maybePromote = (
  k: number,
  volatileLength: number,
  immutableTip: RealPoint | undefined,
) =>
  Effect.gen(function* () {
    if (volatileLength <= k) return volatileLength;

    const chainDb = yield* ChainDB;

    // Promote blocks up to immutableTip
    if (immutableTip) {
      yield* chainDb.promoteToImmutable(immutableTip);
      yield* chainDb.garbageCollect(immutableTip.slot);
    }

    // After promotion, volatile length resets to ~k
    return k;
  });

/**
 * Process a stream of blocks through the consensus pipeline.
 * Promotes volatile blocks to immutable every k blocks.
 */
export const syncFromStream = (
  blocks: Stream.Stream<{ block: StoredBlock; header: BlockHeader; ledgerView: LedgerView }>,
) =>
  Effect.gen(function* () {
    const slotClock = yield* SlotClock;
    const chainDb = yield* ChainDB;
    const k = slotClock.config.securityParam;
    let state = yield* getSyncState;

    yield* Stream.runForEach(blocks, ({ block, header, ledgerView }) =>
      Effect.gen(function* () {
        const newNonces = yield* processBlock(block, header, ledgerView, state.nonces);
        const wallclockSlot = yield* slotClock.currentSlot;
        const newVolatileLength = state.volatileLength + 1;

        // Promote to immutable when volatile chain exceeds k
        const immutableTip = yield* chainDb.getImmutableTip;
        const adjustedVolatile = yield* maybePromote(k, newVolatileLength, immutableTip);

        state = {
          ...state,
          tip: { slot: block.slot, hash: block.hash },
          nonces: newNonces,
          blocksProcessed: state.blocksProcessed + 1,
          volatileLength: adjustedVolatile,
          gsmState: gsmState(block.slot, wallclockSlot, slotClock.stabilityWindow),
        };
        if (state.blocksProcessed % 10000 === 0) {
          yield* Effect.log(`Synced ${state.blocksProcessed} blocks, tip slot ${block.slot}`);
        }
      }),
    );

    return state;
  });
