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
import { writeChainEvent } from "../chain/event-log";
import { ChainDB, LedgerSnapshotStore } from "storage";
import { PrevTip } from "../validate/header";
import type { BlockHeader, LedgerView } from "../validate/header";

// `writeChainEvent` failures are observability infra issues (event-journal
// write rejected; encryption layer error). They MUST NOT block block
// acceptance — a sync that stalls because the audit log is full is worse
// than a sync that runs without the audit log. Each emit wraps the call in
// a warn-and-continue handler so the relay loop keeps making forward
// progress even if the journal goes degraded.
const emitChainEvent = (event: Parameters<typeof writeChainEvent>[0]) =>
  writeChainEvent(event).pipe(
    Effect.catch((cause) => Effect.logWarning(`writeChainEvent ${event._tag} failed: ${cause}`)),
  );

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
  /** Mutable tip; `bodyHash` carries the validated header's declared
   *  body hash through to `fetchAndStoreFullBlock` so the post-fetch
   *  body integrity check can verify the relay's payload against the
   *  authority value (see `validate/block.ts:verifyBodyHash`). Absent
   *  for Byron tips (`bodyHash` is Shelley+-only — Byron's body hash is
   *  computed via the merkle-root path and is not threaded through this
   *  state). */
  tip: Schema.optional(
    Schema.Struct({
      slot: Schema.BigInt,
      blockNo: Schema.BigInt,
      hash: Schema.Uint8Array,
      bodyHash: Schema.optional(Schema.Uint8Array),
    }),
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

      // Chain events for Byron: BlockAccepted + TipAdvanced. Byron blocks
      // are recorded as accepted even though we don't run Praos checks —
      // ChainSync's pre-Babbage protocol guarantees they're in the canonical
      // chain by the time the relay sends them. Downstream subscribers
      // (mempool reorg reaction, dashboard event log) need them tracked.
      yield* emitChainEvent({
        _tag: "BlockAccepted",
        slot: decoded.slot,
        blockNo: decoded.blockNo,
        hash: decoded.hash,
        parentHash: decoded.prevHash,
      });
      yield* emitChainEvent({
        _tag: "TipAdvanced",
        slot: decoded.slot,
        blockNo: decoded.blockNo,
        hash: decoded.hash,
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
    //
    // Two parallel event surfaces fire here:
    //  - `ConsensusEvents` (in-process `PubSub`, transient): legacy UI
    //    notifications used by the early TUI path and oncall logs.
    //  - `ChainEventStream` (`EventLog`-backed, durable): the canonical
    //    chain-history feed consumed by the dashboard atom mirror, the
    //    mempool rollback reaction, and the NodeRpc `SubscribeChainEvents`
    //    stream. EventLog persists to memory in dev / sqlite in apps/
    //    bootstrap, so a cold-start replay reconstructs the recent feed.
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
      // Durable EpochBoundary chain event — emitted AFTER the snapshot
      // write so a downstream replay sees the journal entry only when the
      // epoch nonce is on disk. `epochNonce: newNonces.active` is the
      // randomness fixed for the new epoch (per `praos/nonce.ts`'s
      // active-vs-evolving-vs-candidate triple).
      yield* emitChainEvent({
        _tag: "EpochBoundary",
        fromEpoch: state.nonces.epoch,
        toEpoch: newNonces.epoch,
        epochNonce: newNonces.active,
      });
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

    // Durable BlockAccepted + TipAdvanced. Order matters: `BlockAccepted`
    // first (the journal records WHY the tip moved), `TipAdvanced` second
    // (the chain head transition). Subscribers that filter to one or the
    // other still observe a consistent ordering across blocks.
    yield* emitChainEvent({
      _tag: "BlockAccepted",
      slot: header.slot,
      blockNo: header.blockNo,
      hash: header.hash,
      parentHash: header.prevHash,
    });
    yield* emitChainEvent({
      _tag: "TipAdvanced",
      slot: header.slot,
      blockNo: header.blockNo,
      hash: header.hash,
    });

    // Update opcert counter for this pool after successful validation
    const poolIdBytes = yield* crypto
      .blake2b256(header.issuerVk)
      .pipe(Effect.mapError(mapCryptoErr("handleRollForward.poolIdHash")));
    const poolId = poolIdBytes.toHex();
    const updatedCounters = HashMap.set(state.ocertCounters, poolId, header.opcertSeqNo);

    const result: VolatileState = {
      tip: {
        slot: header.slot,
        blockNo: header.blockNo,
        hash: header.hash,
        bodyHash: header.bodyHash,
      },
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
    const ledgerSnapshots = yield* LedgerSnapshotStore;

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

    // Best-effort rollback depth = (current-tip blockNo) − (rollback-target blockNo).
    // For Origin rollbacks the target's blockNo is 0 by definition. For
    // RealPoint rollbacks we look up the block in `ChainDB` — if our local
    // store hasn't caught up to the rollback point yet, the lookup returns
    // None and we report depth=0 as a safe lower bound. A correct positive
    // depth is needed downstream (mempool clears wholesale on `depth > k`),
    // so when we DO know it we want the right number; when we don't, 0 is
    // strictly conservative (no spurious mempool flush).
    const rollbackBlockNo: bigint = rollbackPoint
      ? yield* chainDb.getBlockAt(rollbackPoint).pipe(
          Effect.map((opt) => (Option.isSome(opt) ? opt.value.blockNo : 0n)),
          Effect.catch(() => Effect.succeed(0n)),
        )
      : 0n;
    const previousBlockNo = state.tip?.blockNo ?? 0n;
    const depth =
      previousBlockNo > rollbackBlockNo ? Number(previousBlockNo - rollbackBlockNo) : 0;

    // Rollback ChainDB volatile state to the rollback point
    if (rollbackPoint) {
      yield* chainDb.rollback(rollbackPoint);
    }

    // Durable RolledBack chain event. `to` discriminates Origin vs
    // RealPoint(slot, hash); `depth` is the best-effort blockNo delta
    // computed above. Emitted AFTER the ChainDB rollback so a downstream
    // replay sees the journal entry only when the volatile store has
    // already converged.
    yield* emitChainEvent({
      _tag: "RolledBack",
      to: rollbackPoint
        ? { _tag: "RealPoint", slot: rollbackPoint.slot, hash: rollbackPoint.hash }
        : { _tag: "Origin" },
      depth,
    });

    // Mutable state revert — must mirror the ChainDB rollback. Two pieces
    // of volatile state are NOT covered by `chainDb.rollback`:
    //
    //   1. `ocertCounters` — the in-memory map of `poolId → highest seqNo
    //      seen`. After rollback the highest seqNo on the new fork may be
    //      lower than what we'd recorded; keeping the stale ceiling would
    //      reject valid blocks with `CounterTooSmall`. Cleared here; the
    //      counter-monotonicity check in `assertOperationalCertificate`
    //      gracefully skips while the map is empty (per
    //      `validate/header.ts:386`), then rebuilds as new blocks land.
    //
    //   2. `nonces` — the active/evolving/candidate nonce triple. If the
    //      rollback crosses an epoch boundary, the live triple is from
    //      the wrong epoch's leader schedule. We re-read the latest
    //      persisted nonces from `LedgerSnapshotStore` (which records
    //      one row per epoch transition); on Origin rollback we fall
    //      back to zero nonces (genesis state). The next block's
    //      `evolveNonce` re-derives the evolving / candidate values
    //      forward from this checkpoint.
    const persistedNonces = yield* ledgerSnapshots.readNonces.pipe(
      Effect.catch(() => Effect.succeed(Option.none())),
    );
    const restoredNonces: Nonces = rollbackPoint
      ? Option.match(persistedNonces, {
          onNone: () => state.nonces,
          onSome: (n) =>
            new Nonces({
              active: n.active,
              evolving: n.evolving,
              candidate: n.candidate,
              epoch: n.epoch,
            }),
        })
      : new Nonces({
          active: new Uint8Array(32),
          evolving: new Uint8Array(32),
          candidate: new Uint8Array(32),
          epoch: 0n,
        });

    // Clear tip after rollback — the blockNo at the rollback point is unknown without
    // a ChainDB lookup. Setting tip=undefined means envelope validation (blockNo/slot/prevHash
    // checks) is skipped for the first post-rollback block. This is safe because ChainSync's
    // internal state ensures the next block chains correctly from the intersection.
    const result: VolatileState = {
      ...state,
      tip: undefined,
      nonces: restoredNonces,
      ocertCounters: HashMap.empty(),
      caughtUp: false,
    };
    return result;
  });
