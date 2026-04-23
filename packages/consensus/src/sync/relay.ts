/**
 * Relay connection — connects to an upstream Cardano relay via N2N protocols.
 *
 * Establishes a TCP connection, performs the N2N handshake, then runs
 * ChainSync + KeepAlive in parallel to sync the chain.
 *
 * Architecture:
 *   TCP socket → Multiplexer → { Handshake, ChainSync, KeepAlive }
 *                                      ↓
 *                              handleRollForward / handleRollBackward
 *                                      ↓
 *                              ConsensusEngine + ChainDB
 */
import { Deferred, Effect, Layer, Option, Ref, Schedule, Schema, Stream } from "effect";
import {
  Multiplexer,
  MultiplexerBuffer,
  HandshakeClient,
  ChainSyncClient,
  KeepAliveClient,
  BlockFetchClient,
  ChainPointType,
  ChainPointSchema,
  ChainSyncMessage,
  HandshakeMessage,
  HandshakeMessageType,
} from "miniprotocols";
import type { ChainPoint } from "miniprotocols";
import { type BlobEntry, ChainDB, blockKey, cborOffsetKey, analyzeBlockCbor } from "storage";
import { Crypto, type CryptoOpError } from "wasm-utils";
import { ConsensusEngine } from "../praos/engine";
import { applyBlock } from "../validate/apply";
import { PeerManager } from "../peer/manager";
import { SlotClock } from "../praos/clock";
import { Nonces } from "../praos/nonce";
import { handleRollForward, handleRollBackward, initialVolatileState } from "./driver";
import type { VolatileState } from "./driver";
import type { LedgerView } from "../validate/header";

/** Network magic for known Cardano networks. */
export const PREPROD_MAGIC = 1;
export const MAINNET_MAGIC = 764824073;

/**
 * N2N protocol versions to propose (spec §3.16, Table 3.20 — N2N v14, 15, 16
 * are the currently-valid window on preprod + mainnet). The server picks
 * the highest mutually-supported version from our proposal table.
 */
const N2N_VERSIONS: ReadonlyArray<number> = [14, 15, 16];

export class RelayError extends Schema.TaggedErrorClass<RelayError>()("RelayError", {
  message: Schema.String,
}) {}

const mapCryptoErr =
  (operation: string) =>
  (cause: CryptoOpError): RelayError =>
    new RelayError({ message: `${operation}: ${String(cause)}` });

/**
 * Exponential backoff schedule for relay reconnection.
 * 1s → 2s → 4s → 8s → ... capped at 60s, with ±25% jitter.
 */
export const RelayRetrySchedule = Schedule.exponential("1 second", 2).pipe(
  Schedule.either(Schedule.spaced("60 seconds")),
  Schedule.jittered,
);

/**
 * Run the N2N handshake with a Cardano relay.
 * Returns the negotiated version number or fails.
 */
const runHandshake = (networkMagic: number) =>
  Effect.gen(function* () {
    const client = yield* HandshakeClient;

    const versionParams = {
      networkMagic,
      initiatorOnlyDiffusionMode: false,
      peerSharing: 0,
      query: false,
    };
    const data = Object.fromEntries(N2N_VERSIONS.map((v) => [v, versionParams]));
    const result = yield* client.propose({ _tag: "node-to-node", data });

    return yield* HandshakeMessage.match(result, {
      [HandshakeMessageType.MsgAcceptVersion]: (msg) =>
        Effect.log(`Handshake accepted: version ${msg.version}`).pipe(Effect.as(msg.version)),
      [HandshakeMessageType.MsgRefuse]: (msg) =>
        Effect.fail(
          new RelayError({
            message: `Handshake refused: ${JSON.stringify(msg.reason)}`,
          }),
        ),
      [HandshakeMessageType.MsgProposeVersions]: (msg) =>
        Effect.fail(new RelayError({ message: `Unexpected handshake response: ${msg._tag}` })),
      [HandshakeMessageType.MsgQueryReply]: (msg) =>
        Effect.fail(new RelayError({ message: `Unexpected handshake response: ${msg._tag}` })),
    });
  });

/**
 * Find the intersection point with the relay using our current tip.
 * Falls back to Origin if no tip exists.
 */
const findIntersection = (tip: { slot: bigint; hash: Uint8Array } | undefined) =>
  Effect.gen(function* () {
    const chainSync = yield* ChainSyncClient;

    const points: ChainPoint[] = tip
      ? [
          { _tag: ChainPointType.RealPoint, slot: Number(tip.slot), hash: tip.hash },
          { _tag: ChainPointType.Origin },
        ]
      : [{ _tag: ChainPointType.Origin }];

    const result = yield* chainSync.findIntersect(points);

    if (ChainSyncMessage.guards.IntersectFound(result)) {
      const slotStr = ChainPointSchema.match(result.point, {
        RealPoint: (p) => String(p.slot),
        Origin: () => "origin",
      });
      yield* Effect.log(`Intersection found at slot ${slotStr}`);
    } else {
      yield* Effect.log("No intersection found — syncing from origin");
    }

    return result;
  });

/**
 * Fetch the full block body via BlockFetch and write derived storage entries
 * (full block CBOR overwriting header-only entry + CBOR offset index).
 * Best-effort — failures are logged, do not affect consensus or chain state.
 */
const fetchAndStoreFullBlock = (tip: { slot: bigint; blockNo: bigint; hash: Uint8Array }) =>
  Effect.gen(function* () {
    const blockFetch = yield* BlockFetchClient;
    const chainDb = yield* ChainDB;
    const crypto = yield* Crypto;
    const point: ChainPoint = {
      _tag: ChainPointType.RealPoint,
      slot: Number(tip.slot),
      hash: tip.hash,
    };
    const maybeStream = yield* blockFetch.requestRange(point, point);
    if (Option.isNone(maybeStream)) return;
    const maybeBlock = yield* Stream.runHead(maybeStream.value);
    if (Option.isNone(maybeBlock)) return;

    const fullBlockCbor = maybeBlock.value;
    const entries: Array<BlobEntry> = [];

    // Overwrite header-only block entry with full block CBOR
    entries.push({ key: blockKey(tip.slot, tip.hash), value: fullBlockCbor });

    // Derive CBOR offset entries from full block
    const analysis = analyzeBlockCbor(fullBlockCbor);
    for (let i = 0; i < analysis.txOffsets.length; i++) {
      const o = analysis.txOffsets[i]!;
      const val = new Uint8Array(8);
      const dv = new DataView(val.buffer);
      dv.setUint32(0, o.offset, false);
      dv.setUint32(4, o.size, false);
      entries.push({ key: cborOffsetKey(tip.slot, i), value: val });
    }

    // Compute tx ids via Crypto service (Effect-based). applyBlock is pure — hash
    // work lives here so it can be routed through a worker-backed Crypto layer.
    const txIds = yield* Effect.forEach(analysis.txOffsets, (o) =>
      crypto.blake2b256(fullBlockCbor.subarray(o.offset, o.offset + o.size)),
    ).pipe(Effect.mapError(mapCryptoErr("fetchAndStoreFullBlock.txId")));

    // Apply block: compute UTxO diffs, account/stake changes from certs
    const diff = applyBlock(fullBlockCbor, txIds);
    entries.push(...diff.utxoInserts);
    entries.push(...diff.accountUpdates);
    entries.push(...diff.stakeUpdates);

    if (entries.length > 0) {
      yield* chainDb.writeBlobEntries(entries);
    }

    // Delete consumed UTxO inputs and deregistered accounts
    const deletes = [...diff.utxoDeletes, ...diff.accountDeletes];
    if (deletes.length > 0) {
      yield* chainDb.deleteBlobEntries(deletes);
    }
  });

/**
 * Run the ChainSync loop — continuously request blocks from the relay.
 *
 * This is the main sync loop. It:
 * 1. Calls requestNext() on the ChainSync client
 * 2. On RollForward: validates header, stores block, evolves nonces
 * 3. After validation: fetches full block via BlockFetch, writes offsets
 * 4. On RollBackward: reverts state to the rollback point
 * 5. Repeats until the connection is closed
 */
const chainSyncLoop = (
  peerId: string,
  ledgerView: LedgerView,
  initialNonces: Nonces,
  initialTip: { slot: bigint; blockNo: bigint; hash: Uint8Array } | undefined,
  volatileStateRef?: Ref.Ref<VolatileState>,
) =>
  Effect.gen(function* () {
    const chainSync = yield* ChainSyncClient;

    // All mutable state managed via Ref (no mutable `let`)
    const stateRef = yield* Ref.make(initialVolatileState(initialTip, initialNonces));

    // Deferred commit gate chain — ensures sequential nonce evolution
    // across blocks while allowing validation to proceed in parallel
    const initialGate = yield* Deferred.make<void>();
    yield* Deferred.succeed(initialGate, undefined); // first block: no predecessor
    const gateRef = yield* Ref.make(initialGate);

    // Sync loop — runs until connection drops or interrupted.
    // Individual block processing errors are logged and skipped;
    // transport-level errors (socket, schema) propagate and trigger reconnection.
    yield* Effect.repeat(
      Effect.gen(function* () {
        const msg = yield* chainSync.requestNext();

        if (ChainSyncMessage.guards.RollForward(msg)) {
          const serverTip = {
            ...ChainPointSchema.match(msg.tip.point, {
              RealPoint: (p) => ({ slot: BigInt(p.slot), hash: p.hash }),
              Origin: () => ({ slot: 0n, hash: new Uint8Array(32) }),
            }),
            blockNo: BigInt(msg.tip.blockNo),
          };

          // Create this block's commit gate
          const thisCommitDone = yield* Deferred.make<void>();
          const prevCommitDone = yield* Ref.get(gateRef);
          yield* Ref.set(gateRef, thisCommitDone);

          // Wait for previous commit to complete (nonce dependency)
          yield* Deferred.await(prevCommitDone);

          // Process block: validate + store + evolve nonces
          const state = yield* Ref.get(stateRef);
          yield* handleRollForward(
            msg.header,
            msg.eraVariant,
            serverTip,
            state,
            peerId,
            ledgerView,
            msg.byronPrefix?.[0],
          ).pipe(
            Effect.tap((newState) =>
              Effect.gen(function* () {
                yield* Ref.set(stateRef, newState);
                if (volatileStateRef) yield* Ref.set(volatileStateRef, newState);
              }),
            ),
            Effect.matchEffect({
              onSuccess: () =>
                Effect.gen(function* () {
                  // After header validation + storage, fetch full block body
                  // to write CBOR offsets and update block entry with full CBOR.
                  // Best-effort — skip Byron (era <= 1) and tolerate failures.
                  const currentState = yield* Ref.get(stateRef);
                  if (currentState.tip && msg.eraVariant > 1) {
                    yield* fetchAndStoreFullBlock(currentState.tip).pipe(
                      Effect.scoped,
                      Effect.catch((err) => Effect.logWarning(`[sync] BlockFetch skipped: ${err}`)),
                    );
                  }
                }),
              onFailure: (err) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning(
                    `[sync] Block processing failed (era ${msg.eraVariant}, tip ${serverTip.slot}): ${err}`,
                  );
                  // Clear tip to prevent cascading envelope validation failures.
                  // The next block will skip envelope checks, trusting ChainSync ordering.
                  const s = yield* Ref.get(stateRef);
                  const cleared = { ...s, tip: undefined };
                  yield* Ref.set(stateRef, cleared);
                  if (volatileStateRef) {
                    yield* Ref.set(volatileStateRef, cleared);
                  }
                }),
            }),
            // Guarantee gate signaling even on failure — prevents downstream deadlock
            Effect.ensuring(Deferred.succeed(thisCommitDone, undefined)),
          );

          const currentState = yield* Ref.get(stateRef);
          if (currentState.blocksProcessed % 1000 === 0 && currentState.blocksProcessed > 0) {
            yield* Effect.log(
              `[sync] ${currentState.blocksProcessed} blocks, tip slot ${currentState.tip?.slot ?? 0n}`,
            );
          }
        } else {
          const rollbackPoint = ChainPointSchema.match(msg.point, {
            RealPoint: (p) => ({ slot: BigInt(p.slot), hash: p.hash }),
            Origin: () => undefined,
          });

          const serverTip = {
            ...ChainPointSchema.match(msg.tip.point, {
              RealPoint: (p) => ({ slot: BigInt(p.slot), hash: p.hash }),
              Origin: () => ({ slot: 0n, hash: new Uint8Array(32) }),
            }),
            blockNo: BigInt(msg.tip.blockNo),
          };

          const state = yield* Ref.get(stateRef);
          const newState = yield* handleRollBackward(rollbackPoint, serverTip, state, peerId);
          yield* Ref.set(stateRef, newState);
          if (volatileStateRef) yield* Ref.set(volatileStateRef, newState);

          // Reset commit gate for new chain after rollback
          const freshGate = yield* Deferred.make<void>();
          yield* Deferred.succeed(freshGate, undefined);
          yield* Ref.set(gateRef, freshGate);
        }
      }),
      Schedule.forever,
    );
  });

/**
 * Connect to an upstream Cardano relay and sync the chain.
 *
 * This creates the full N2N connection stack:
 *   Socket → Multiplexer → Handshake → ChainSync + KeepAlive
 *
 * Requires: ConsensusEngine, ChainDB, SlotClock, PeerManager, Socket, Scope
 */
export const connectToRelay = (
  peerId: string,
  networkMagic: number,
  ledgerView: LedgerView,
  snapshotState?: {
    tip: { slot: bigint; hash: Uint8Array } | undefined;
    nonces: Nonces;
  },
  volatileStateRef?: Ref.Ref<VolatileState>,
) =>
  Effect.gen(function* () {
    const peerManager = yield* PeerManager;
    const chainDb = yield* ChainDB;
    const slotClock = yield* SlotClock;

    // Register peer
    yield* peerManager.addPeer(peerId);

    // 1. Handshake
    yield* runHandshake(networkMagic);

    // 2. Find intersection — prefer ChainDB tip (evolved state) over snapshot tip.
    // On reconnection, ChainDB has the latest stored tip from the previous session.
    const dbTip = yield* chainDb.getTip;
    const intersectionTip = Option.isSome(dbTip) ? dbTip.value : snapshotState?.tip;
    yield* findIntersection(intersectionTip);

    // 3. Initialize nonces — prefer persisted (ChainDB), then snapshot, then zeros.
    const persistedNonces = yield* chainDb.readNonces;
    const nonces = Option.isSome(persistedNonces)
      ? new Nonces({
          active: persistedNonces.value.active,
          evolving: persistedNonces.value.evolving,
          candidate: persistedNonces.value.candidate,
          epoch: persistedNonces.value.epoch,
        })
      : (snapshotState?.nonces ??
        (() => {
          const epoch = intersectionTip ? slotClock.slotToEpoch(intersectionTip.slot) : 0n;
          return new Nonces({
            active: new Uint8Array(32),
            evolving: new Uint8Array(32),
            candidate: new Uint8Array(32),
            epoch,
          });
        })());

    // 4. Run ChainSync + KeepAlive in parallel.
    // Initial tip is undefined — envelope validation (blockNo/slot/prevHash) is skipped
    // for the first block after intersection. Subsequent blocks chain correctly from there.
    yield* Effect.all(
      [
        chainSyncLoop(peerId, ledgerView, nonces, undefined, volatileStateRef),
        Effect.gen(function* () {
          const keepAlive = yield* KeepAliveClient;
          yield* keepAlive.run();
        }),
      ],
      { concurrency: "unbounded" },
    );
  }).pipe(
    // Provide protocol client layers (require Multiplexer in environment)
    Effect.provide(
      Layer.mergeAll(
        HandshakeClient.layer,
        ChainSyncClient.layer,
        KeepAliveClient.layer,
        BlockFetchClient.layer,
      ),
    ),
    // Provide Multiplexer + Buffer layers (requires Socket in environment)
    Effect.provide(Multiplexer.layer.pipe(Layer.provide(MultiplexerBuffer.layer))),
  );
