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
import { Config, Effect, Layer, Schedule, Schema, Scope } from "effect";
import {
  Multiplexer,
  MultiplexerBuffer,
  HandshakeClient,
  ChainSyncClient,
  KeepAliveClient,
  ChainPointType,
  HandshakeMessageType,
} from "miniprotocols";
import type { ChainPoint } from "miniprotocols";
import { ChainDB } from "storage/services/chain-db";
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

    if (result._tag === HandshakeMessageType.MsgAcceptVersion) {
      yield* Effect.log(`Handshake accepted: version ${result.version}`);
      return result.version;
    }

    if (result._tag === HandshakeMessageType.MsgRefuse) {
      return yield* Effect.fail(
        new RelayError({ message: `Handshake refused: ${JSON.stringify(result.reason)}`, cause: result }),
      );
    }

    return yield* Effect.fail(
      new RelayError({ message: `Unexpected handshake response: ${result._tag}`, cause: result }),
    );
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

    if (result._tag === "IntersectFound") {
      yield* Effect.log(`Intersection found at slot ${result.point._tag === "RealPoint" ? result.point.slot : "origin"}`);
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
    let state = initialVolatileState(initialTip, initialNonces);

    // Sync loop — runs until connection drops or interrupted
    yield* Effect.repeat(
      Effect.gen(function* () {
        const msg = yield* chainSync.requestNext();

        if (msg._tag === "RollForward") {
          const serverTip = {
            slot: BigInt(msg.tip.point._tag === "RealPoint" ? msg.tip.point.slot : 0),
            blockNo: BigInt(msg.tip.blockNo),
            hash: msg.tip.point._tag === "RealPoint" ? msg.tip.point.hash : new Uint8Array(32),
          };

          state = yield* handleRollForward(
            msg.header,
            serverTip,
            state,
            peerId,
            ledgerView,
          );

          if (state.blocksProcessed % 1000 === 0 && state.blocksProcessed > 0) {
            yield* Effect.log(
              `[sync] ${state.blocksProcessed} blocks, tip slot ${state.tip?.slot ?? 0n}`,
            );
          }
        } else {
          const rollbackPoint = msg.point._tag === "RealPoint"
            ? { slot: BigInt(msg.point.slot), hash: msg.point.hash }
            : undefined;

          const serverTip = {
            slot: BigInt(msg.tip.point._tag === "RealPoint" ? msg.tip.point.slot : 0),
            blockNo: BigInt(msg.tip.blockNo),
            hash: msg.tip.point._tag === "RealPoint" ? msg.tip.point.hash : new Uint8Array(32),
          };

          state = yield* handleRollBackward(rollbackPoint, serverTip, state, peerId);
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
) =>
  Effect.gen(function* () {
    const peerManager = yield* PeerManager;
    const chainDb = yield* ChainDB;
    const slotClock = yield* SlotClock;

    // Register peer
    yield* peerManager.addPeer(peerId);

    // 1. Handshake
    yield* runHandshake(networkMagic);

    // 2. Find intersection
    const tip = yield* chainDb.getTip;
    yield* findIntersection(tip);

    // 3. Initialize nonces from current epoch
    const epoch = tip ? slotClock.slotToEpoch(tip.slot) : 0n;
    const nonces = new Nonces({
      active: new Uint8Array(32),
      evolving: new Uint8Array(32),
      candidate: new Uint8Array(32),
      epoch,
    });

    // 4. Run ChainSync + KeepAlive in parallel
    yield* Effect.all(
      [
        chainSyncLoop(peerId, ledgerView, nonces, tip ?? undefined),
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
