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
import { Deferred, Effect, Layer, Option, Ref, Schedule, Schema } from "effect";
import {
  Multiplexer,
  MultiplexerBuffer,
  HandshakeClient,
  ChainSyncClient,
  KeepAliveClient,
  ChainPointType,
  ChainPointSchema,
  ChainSyncMessage,
  HandshakeMessage,
  HandshakeMessageType,
} from "miniprotocols";
import type { ChainPoint } from "miniprotocols";
import { ChainDB } from "storage";
import { ConsensusEngine } from "./consensus-engine";
import { PeerManager } from "./peer-manager";
import { SlotClock } from "./clock";
import { Nonces } from "./nonce";
import {
  handleRollForward,
  handleRollBackward,
  initialVolatileState,
} from "./chain-sync-driver";
import type { LedgerView } from "./validate-header";

/** Network magic for known Cardano networks. */
export const PREPROD_MAGIC = 1;
export const MAINNET_MAGIC = 764824073;

/** N2N protocol version to negotiate (preprod/mainnet accept 14+). */
const N2N_VERSION = 14;

export class RelayError extends Schema.TaggedErrorClass<RelayError>()(
  "RelayError",
  { message: Schema.String, cause: Schema.Defect },
) {}

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

    const result = yield* client.propose({
      _tag: "node-to-node",
      data: {
        [N2N_VERSION]: {
          networkMagic,
          initiatorOnlyDiffusionMode: false,
          peerSharing: 0,
          query: false,
        },
      },
    });

    return yield* HandshakeMessage.match(result, {
      [HandshakeMessageType.MsgAcceptVersion]: (msg) =>
        Effect.gen(function* () {
          yield* Effect.log(`Handshake accepted: version ${msg.version}`);
          return msg.version;
        }),
      [HandshakeMessageType.MsgRefuse]: (msg) =>
        Effect.fail(
          new RelayError({ message: `Handshake refused: ${JSON.stringify(msg.reason)}`, cause: msg }),
        ),
      [HandshakeMessageType.MsgProposeVersions]: (msg) =>
        Effect.fail(
          new RelayError({ message: `Unexpected handshake response: ${msg._tag}`, cause: msg }),
        ),
      [HandshakeMessageType.MsgQueryReply]: (msg) =>
        Effect.fail(
          new RelayError({ message: `Unexpected handshake response: ${msg._tag}`, cause: msg }),
        ),
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
 * Run the ChainSync loop — continuously request blocks from the relay.
 *
 * This is the main sync loop. It:
 * 1. Calls requestNext() on the ChainSync client
 * 2. On RollForward: validates header, stores block, evolves nonces
 * 3. On RollBackward: reverts state to the rollback point
 * 4. Repeats until the connection is closed
 */
const chainSyncLoop = (
  peerId: string,
  ledgerView: LedgerView,
  initialNonces: Nonces,
  initialTip: { slot: bigint; hash: Uint8Array } | undefined,
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
          yield* handleRollForward(msg.header, msg.eraVariant, serverTip, state, peerId, ledgerView).pipe(
            Effect.tap((newState) => Ref.set(stateRef, newState)),
            Effect.matchEffect({
              onSuccess: () => Effect.void,
              onFailure: (err) => Effect.logWarning(`[sync] Block processing failed (era ${msg.eraVariant}, tip ${serverTip.slot}): ${err}`),
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
    const tip = Option.isSome(dbTip) ? dbTip.value : snapshotState?.tip;
    yield* findIntersection(tip);

    // 3. Initialize nonces — from snapshot if available, else zeros.
    // NOTE: Nonces are not persisted in ChainDB yet. On reconnection, snapshot
    // nonces are stale but still better than zeros. Nonce evolution will
    // catch up after the first epoch transition. TODO: persist nonces in ChainDB.
    const nonces = snapshotState?.nonces ?? (() => {
      const epoch = tip ? slotClock.slotToEpoch(tip.slot) : 0n;
      return new Nonces({
        active: new Uint8Array(32),
        evolving: new Uint8Array(32),
        candidate: new Uint8Array(32),
        epoch,
      });
    })();

    // 4. Run ChainSync + KeepAlive in parallel
    yield* Effect.all(
      [
        chainSyncLoop(peerId, ledgerView, nonces, tip),
        Effect.gen(function* () {
          const keepAlive = yield* KeepAliveClient;
          yield* keepAlive.run();
        }),
      ],
      { concurrency: "unbounded" },
    );
  }).pipe(
    // Provide protocol client layers (require Multiplexer in environment)
    Effect.provide(Layer.mergeAll(
      HandshakeClient.layer,
      ChainSyncClient.layer,
      KeepAliveClient.layer,
    )),
    // Provide Multiplexer + Buffer layers (requires Socket in environment)
    Effect.provide(Multiplexer.layer.pipe(Layer.provide(MultiplexerBuffer.layer))),
  );
