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
import { Deferred, Effect, HashMap, Option, Ref, Schema } from "effect";
import { Crypto, type CryptoOpError } from "wasm-utils";
import { SlotClock } from "../praos/clock";
import { validateHeader } from "../validate/header";
import { PeerManager } from "../peer/manager";
import { ChainTip } from "../chain/selection";
import { Nonces, evolveNonce, deriveEpochNonce, isPastStabilizationWindow } from "../praos/nonce";
import { decodeWrappedHeader, DecodedHeader } from "../bridges/header";
import { ConsensusEvents, ConsensusEventKind } from "../peer/events";
import { ChainDB, LedgerSnapshotStore } from "storage";
import { PrevTip } from "../validate/header";
import type { BlockHeader, LedgerView } from "../validate/header";

export class ChainSyncDriverError extends Schema.TaggedErrorClass<ChainSyncDriverError>()(
  "ChainSyncDriverError",
  { message: Schema.String },
) {}

const mapCryptoErr =
  (operation: string) =>
  (cause: CryptoOpError): ChainSyncDriverError =>
    new ChainSyncDriverError({ message: `${operation}: ${String(cause)}` });

/** Volatile chain state — tracks the mutable tip and recent blocks. */
export const VolatileState = Schema.Struct({
  tip: Schema.optional(
    Schema.Struct({ slot: Schema.BigInt, blockNo: Schema.BigInt, hash: Schema.Uint8Array }),
  ),
  nonces: Nonces,
  /** Per-pool opcert sequence counters (poolId hex → last seqNo). */
  ocertCounters: Schema.HashMap(Schema.String, Schema.Number),
  blocksProcessed: Schema.Number,
  caughtUp: Schema.Boolean,
});
export type VolatileState = typeof VolatileState.Type;

/** Initial volatile state — loaded from snapshot or genesis. */
export const initialVolatileState = (
  tip: { slot: bigint; blockNo: bigint; hash: Uint8Array } | undefined,
  nonces: Nonces,
  ocertCounters: HashMap.HashMap<string, number> = HashMap.empty(),
): VolatileState => {
  const result: VolatileState = {
    tip,
    nonces,
    ocertCounters,
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
  /** Byron subtag from ChainSync byronPrefix[0] (0=EBB, 1=main). */
  byronSubtag?: number,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto;
    const peerManager = yield* PeerManager;
    const slotClock = yield* SlotClock;
    const chainDb = yield* ChainDB;
    const ledgerSnapshots = yield* LedgerSnapshotStore;

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
    const decoded = yield* decodeWrappedHeader(headerBytes, eraVariant, byronSubtag);

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
        tip: { slot: decoded.slot, blockNo: decoded.blockNo, hash: decoded.hash },
        nonces: state.nonces,
        ocertCounters: state.ocertCounters,
        blocksProcessed: state.blocksProcessed + 1,
        caughtUp: false,
      };
      return result;
    }

    // Shelley+ path: Praos validation + nonce evolution
    const header = decoded.header;

    // Build prevTip for envelope validation (slot/blockNo/hash chaining)
    const prevTip: PrevTip | undefined = state.tip
      ? { slot: state.tip.slot, blockNo: state.tip.blockNo, hash: state.tip.hash }
      : undefined;

    // Inject current opcert counters into the ledger view for per-pool counter checks.
    const viewWithCounters: LedgerView = {
      ...ledgerView,
      ocertCounters: state.ocertCounters,
    };

    // Run envelope checks + 5 Praos assertions. Pool-dependent assertions
    // (VRF key lookup, VRF proof, leader stake) gracefully skip when the
    // LedgerView has no pool data (genesis sync without bootstrap).
    // Pool-independent assertions (KES signature, opcert) always run.
    // `Crypto` is provided by the app-level layer composition, so
    // `validateHeader` binds it from the enclosing fiber.
    yield* validateHeader(header, viewWithCounters, prevTip);

    // Storage and nonce evolution are INDEPENDENT — run in parallel.
    // Storage writes to DB; nonce computation reads only header fields.
    const [, newNonces] = yield* Effect.all(
      [
        // I/O-bound: store block metadata + header bytes in ChainDB
        chainDb.addBlock({
          slot: header.slot,
          hash: header.hash,
          prevHash: header.prevHash,
          blockNo: header.blockNo,
          blockSizeBytes: headerBytes.byteLength,
          blockCbor: headerBytes,
        }),
        // CPU-bound: compute nonces purely from header fields (two blake2b hashes via Crypto).
        Effect.gen(function* () {
          const blockEpoch = slotClock.slotToEpoch(header.slot);
          // Epoch-boundary tick: when the block advances past the current
          // `epoch`, derive the next epoch's nonce (`blake2b(candidate ∥
          // prevHash)`) and rebuild `Nonces` atomically. Non-boundary
          // blocks reuse the incoming triple.
          const nonces =
            blockEpoch > state.nonces.epoch
              ? yield* deriveEpochNonce(state.nonces.candidate, header.prevHash).pipe(
                  Effect.mapError(mapCryptoErr("handleRollForward.deriveEpochNonce")),
                  Effect.map(
                    (newEpochNonce) =>
                      new Nonces({
                        active: newEpochNonce,
                        evolving: newEpochNonce,
                        candidate: newEpochNonce,
                        epoch: blockEpoch,
                      }),
                  ),
                )
              : state.nonces;

          const newEvolving = yield* evolveNonce(nonces.evolving, header.nonceVrfOutput).pipe(
            Effect.mapError(mapCryptoErr("handleRollForward.evolveNonce")),
          );
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
      ],
      { concurrency: "unbounded" },
    );

    // Acquire the optional `ConsensusEvents` service once; the two emit
    // sites below reuse the same `Option<ConsensusEvents>` instead of
    // re-invoking `Effect.serviceOption`.
    const eventsOpt = yield* Effect.serviceOption(ConsensusEvents);

    // Persist nonces on epoch boundary transitions + emit EpochTransition event
    if (newNonces.epoch > state.nonces.epoch) {
      yield* ledgerSnapshots.writeNonces(
        newNonces.epoch,
        newNonces.active,
        newNonces.evolving,
        newNonces.candidate,
      );
      if (Option.isSome(eventsOpt)) {
        yield* eventsOpt.value.emit({
          _tag: ConsensusEventKind.EpochTransition,
          fromEpoch: state.nonces.epoch,
          toEpoch: newNonces.epoch,
        });
      }
    }

    // Emit TipChanged event (best-effort — service is optional)
    if (Option.isSome(eventsOpt)) {
      yield* eventsOpt.value.emit({
        _tag: ConsensusEventKind.TipChanged,
        slot: header.slot,
        hash: header.hash,
        blockNo: header.blockNo,
        blocksProcessed: state.blocksProcessed + 1,
      });
    }

    // Update opcert counter for this pool after successful validation
    const poolIdBytes = yield* crypto
      .blake2b256(header.issuerVk)
      .pipe(Effect.mapError(mapCryptoErr("handleRollForward.poolIdHash")));
    const poolId = poolIdBytes.toHex();
    const updatedCounters = HashMap.set(state.ocertCounters, poolId, header.opcertSeqNo);

    const result: VolatileState = {
      tip: { slot: header.slot, blockNo: header.blockNo, hash: header.hash },
      nonces: newNonces,
      ocertCounters: updatedCounters,
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

    // Clear tip after rollback — the blockNo at the rollback point is unknown without
    // a ChainDB lookup. Setting tip=undefined means envelope validation (blockNo/slot/prevHash
    // checks) is skipped for the first post-rollback block. This is safe because ChainSync's
    // internal state ensures the next block chains correctly from the intersection.
    const result: VolatileState = {
      ...state,
      tip: undefined,
      caughtUp: false,
    };
    return result;
  });
