/**
 * Gerolamino TUI node — sync-to-tip Cardano data node.
 *
 * Bootstraps remotely from a bootstrap server via WebSocket, then
 * validates headers via consensus layer, stores data via BlobStore (LSM) + SQL.
 *
 * SQL access:
 *   layerBunSqlClient → SqlClient
 *     → runMigrations (consumes SqlClient) — creates tables
 *     → ChainDBLive (consumes BlobStore + SqlClient) → ChainDB
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as BunWorker from "@effect/platform-bun/BunWorker";
import {
  Config,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Path,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { Command, Flag } from "effect/unstable/cli";
import {
  getNodeStatus,
  monitorLoop,
  ConsensusEngineWithWorkerCrypto,
  SlotClock,
  SlotClockLive,
  SlotClockLayerFromConfig,
  PREPROD_CONFIG,
  PeerManager,
  PeerManagerLive,
  connectToRelay,
  RelayRetrySchedule,
  PREPROD_MAGIC,
  MAINNET_MAGIC,
  extractLedgerView,
  extractNonces,
  extractSnapshotTip,
  initialVolatileState,
  Nonces,
} from "consensus";
import type { LedgerView } from "consensus";
import { decodeExtLedgerState } from "ledger";
import { connect, BootstrapMessage, BootstrapMessageKind } from "bootstrap";
import type { BootstrapMessageType } from "bootstrap";
import {
  BlobStore,
  PREFIX_UTXO,
  blockKey,
  stakeKey,
  ChainDBLive,
  runMigrations,
} from "storage";
import { layer as layerBunSqlClient } from "@effect/sql-sqlite-bun/SqliteClient";
import { layerLsm } from "lsm-tree";
import {
  pushNodeState,
  pushBootstrapProgress,
  pushNetworkInfo,
  pushPeers,
} from "./dashboard/atoms.ts";
import { concat } from "consensus";

/** Bootstrap completed without receiving the expected LedgerState message. */
class BootstrapMissingLedgerState extends Schema.TaggedErrorClass<BootstrapMissingLedgerState>()(
  "BootstrapMissingLedgerState",
  {},
) {}

const start = Command.make(
  "start",
  {
    bootstrapUrl: Flag.string("bootstrap-url").pipe(
      Flag.withAlias("b"),
      Flag.withDescription("Bootstrap server WebSocket URL"),
      Flag.withFallbackConfig(Config.string("BOOTSTRAP_SERVER_URL")),
      Flag.withDefault("ws://178.156.252.81:3040/bootstrap"),
    ),
    genesis: Flag.boolean("genesis").pipe(
      Flag.withAlias("g"),
      Flag.withDescription("Sync from genesis (no bootstrap server needed)"),
      Flag.withDefault(false),
    ),
    relayHost: Flag.string("relay-host").pipe(
      Flag.withDescription("Upstream relay host"),
      Flag.withFallbackConfig(Config.string("RELAY_HOST")),
      Flag.withDefault("preprod-node.play.dev.cardano.org"),
    ),
    relayPort: Flag.integer("relay-port").pipe(
      Flag.withDescription("Upstream relay port"),
      Flag.withFallbackConfig(Config.int("RELAY_PORT")),
      Flag.withDefault(3001),
    ),
    network: Flag.string("network").pipe(
      Flag.withDescription("Cardano network (preprod|mainnet)"),
      Flag.withDefault("preprod"),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      yield* Effect.log("Gerolamino TUI node starting...");
      yield* Effect.log(`Relay: ${config.relayHost}:${config.relayPort} (${config.network})`);

      // Push network info to dashboard atoms
      yield* pushNetworkInfo({
        network: config.network === "mainnet" ? "mainnet" : "preprod",
        protocolMagic: config.network === "mainnet" ? 764824073 : 1,
        relayHost: config.relayHost,
        relayPort: config.relayPort,
      });

      // Run migrations via SqlClient before using ChainDB
      yield* runMigrations;
      yield* Effect.log("Database migrations complete.");

      type SnapshotState = {
        tip: { slot: bigint; hash: Uint8Array } | undefined;
        nonces: ReturnType<typeof extractNonces>;
      };

      const { ledgerView, snapshotState } = yield* config.genesis
        ? Effect.gen(function* () {
            yield* Effect.log("Genesis mode: syncing from origin (no bootstrap)");
            yield* pushNodeState({ status: "connecting" });
            const genesisLedgerView: LedgerView = {
              epochNonce: new Uint8Array(32),
              poolVrfKeys: HashMap.empty(),
              poolStake: HashMap.empty(),
              totalStake: 0n,
              activeSlotsCoeff: 0.05,
              maxKesEvolutions: 62,
            };
            const noSnapshot: SnapshotState | undefined = undefined;
            return { ledgerView: genesisLedgerView, snapshotState: noSnapshot };
          })
        : Effect.gen(function* () {
            yield* Effect.log(`Connecting to bootstrap server: ${config.bootstrapUrl}`);
            yield* pushNodeState({ status: "bootstrapping" });
            const store = yield* BlobStore;

            const blobCountRef = yield* Ref.make(0);
            const blockCountRef = yield* Ref.make(0);
            const ledgerViewRef = yield* Ref.make<LedgerView | undefined>(undefined);
            const snapshotStateRef = yield* Ref.make<SnapshotState | undefined>(undefined);

            yield* Effect.scoped(
              Effect.gen(function* () {
                const stream = yield* connect(config.bootstrapUrl);

                yield* stream.pipe(
                  Stream.runForEach(
                    BootstrapMessage.match({
                      Init: (m) =>
                        Effect.gen(function* () {
                          yield* Effect.log(
                            `Bootstrap: slot ${m.snapshotSlot}, magic ${m.protocolMagic}, ${m.totalChunks} chunks`,
                          );
                          yield* pushBootstrapProgress({
                            protocolMagic: m.protocolMagic,
                            totalChunks: m.totalChunks,
                            phase: "awaiting-ledger-state",
                          });
                        }),

                      LedgerState: (m) =>
                        Effect.gen(function* () {
                          yield* Effect.log(`Ledger state: ${m.payload.length} bytes, decoding...`);
                          const extState = yield* decodeExtLedgerState(m.payload);
                          yield* Effect.log(
                            `Decoded: era ${extState.currentEra}, epoch ${extState.newEpochState.epoch}, ` +
                              `${extState.newEpochState.poolDistr.pools.size} pools`,
                          );

                          const lv = yield* extractLedgerView(extState);
                          const nonces = extractNonces(extState);
                          const tip = extractSnapshotTip(extState);
                          yield* Ref.set(ledgerViewRef, lv);
                          yield* Ref.set(snapshotStateRef, { tip, nonces });

                          yield* Effect.log(
                            `Bootstrap: tip slot ${tip?.slot ?? "origin"}, totalStake ${lv.totalStake}, ` +
                              `${HashMap.size(lv.poolVrfKeys)} VRF keys loaded`,
                          );
                          yield* pushBootstrapProgress({ ledgerStateReceived: true });
                        }),

                      LedgerMeta: (m) => Effect.log(`Ledger meta: ${m.payload.length} bytes`),

                      BlobEntries: (m) =>
                        Effect.gen(function* () {
                          yield* store.putBatch(
                            m.entries.map((e) => ({
                              key: concat(PREFIX_UTXO, e.key),
                              value: e.value,
                            })),
                          );
                          const newCount = yield* Ref.updateAndGet(
                            blobCountRef,
                            (n) => n + m.count,
                          );
                          if (newCount % 50000 === 0) {
                            yield* Effect.log(`UTxO entries received: ${newCount}`);
                            yield* pushBootstrapProgress({
                              blobEntriesReceived: newCount,
                              phase: "receiving-utxos",
                            });
                          }
                        }),

                      Block: (m) =>
                        Effect.gen(function* () {
                          yield* store.put(blockKey(m.slotNo, m.headerHash), m.blockCbor);
                          const newCount = yield* Ref.updateAndGet(blockCountRef, (n) => n + 1);
                          if (newCount % 10000 === 0) {
                            yield* Effect.log(`Blocks received: ${newCount}`);
                            yield* pushBootstrapProgress({
                              blocksReceived: newCount,
                              phase: "receiving-blocks",
                            });
                          }
                        }),

                      Progress: (m) => Effect.log(`Progress: ${m.phase} ${m.current}/${m.total}`),

                      Complete: () =>
                        Effect.gen(function* () {
                          const blobCount = yield* Ref.get(blobCountRef);
                          const blockCount = yield* Ref.get(blockCountRef);
                          yield* Effect.log(
                            `Bootstrap complete: ${blobCount} UTxO entries, ${blockCount} blocks`,
                          );
                          yield* pushBootstrapProgress({
                            blobEntriesReceived: blobCount,
                            blocksReceived: blockCount,
                            phase: "complete",
                          });
                        }),
                    }),
                  ),
                );
              }),
            );

            const lv = yield* Ref.get(ledgerViewRef);
            if (!lv) return yield* new BootstrapMissingLedgerState();

            // Populate stake distribution table from LedgerView
            const stakeEntries: Array<{ readonly key: Uint8Array; readonly value: Uint8Array }> = [];
            for (const [poolHashHex, stake] of lv.poolStake) {
              const val = new Uint8Array(8);
              new DataView(val.buffer).setBigUint64(0, stake);
              stakeEntries.push({ key: stakeKey(Uint8Array.fromHex(poolHashHex)), value: val });
            }
            if (stakeEntries.length > 0) {
              yield* store.putBatch(stakeEntries);
              yield* Effect.log(`Wrote ${stakeEntries.length} stake distribution entries`);
            }

            return {
              ledgerView: lv,
              snapshotState: yield* Ref.get(snapshotStateRef),
            };
          });

      // Shared volatile state ref — written by relay sync loop, read by monitor.
      const volatileRef = yield* Ref.make(
        initialVolatileState(
          snapshotState?.tip,
          snapshotState?.nonces ?? new Nonces({
            active: new Uint8Array(32),
            evolving: new Uint8Array(32),
            candidate: new Uint8Array(32),
            epoch: 0n,
          }),
        ),
      );

      const status = yield* getNodeStatus(volatileRef);
      yield* Effect.log(`Tip: slot ${status.tipSlot} / ${status.currentSlot}`);
      yield* Effect.log(`Epoch: ${status.epochNumber}`);
      yield* Effect.log(`Sync: ${status.syncPercent}%`);
      yield* Effect.log(`GSM: ${status.gsmState}`);

      // Push initial node status to dashboard
      yield* pushNodeState({
        status: "syncing",
        tipSlot: status.tipSlot,
        tipBlockNo: status.tipBlockNo,
        currentSlot: status.currentSlot,
        epochNumber: status.epochNumber,
        gsmState: status.gsmState,
        syncPercent: status.syncPercent,
      });

      const networkMagic = config.network === "mainnet" ? MAINNET_MAGIC : PREPROD_MAGIC;
      const peerId = `${config.relayHost}:${config.relayPort}`;

      // Dashboard-aware monitor loop: pushes status + peers to atoms every 10s.
      const dashboardMonitorLoop: typeof monitorLoop = Effect.gen(function* () {
        const peerManager = yield* PeerManager;

        yield* Effect.repeat(
          Effect.gen(function* () {
            const nodeStatus = yield* getNodeStatus(volatileRef);
            const stalled = yield* peerManager.detectStalls;
            const peers = yield* peerManager.getPeers;

            if (stalled.length > 0) {
              yield* Effect.log(`Detected ${stalled.length} stalled peers: ${stalled.join(", ")}`);
            }

            // Push to dashboard atoms
            yield* pushNodeState({
              status: nodeStatus.syncPercent >= 100 ? "caught-up" : "syncing",
              tipSlot: nodeStatus.tipSlot,
              tipBlockNo: nodeStatus.tipBlockNo,
              currentSlot: nodeStatus.currentSlot,
              epochNumber: nodeStatus.epochNumber,
              gsmState: nodeStatus.gsmState,
              syncPercent: nodeStatus.syncPercent,
              blocksProcessed: nodeStatus.blocksProcessed,
            });
            yield* pushPeers(
              peers.map((p) => ({
                id: p.peerId,
                status:
                  p.status === "syncing" || p.status === "synced"
                    ? "connected"
                    : p.status === "stalled"
                      ? "stalled"
                      : "disconnected",
                tipSlot: p.tip?.slot ?? 0n,
              })),
            );
          }).pipe(Effect.catch((e) => Effect.logWarning(`Monitor check failed: ${e}`))),
          Schedule.fixed("10 seconds"),
        );
      });

      // Connect to upstream relay with exponential backoff reconnection.
      // Monitor loop runs in parallel alongside relay sync.
      yield* Effect.all(
        [
          Effect.retry(
            connectToRelay(peerId, networkMagic, ledgerView, snapshotState, volatileRef).pipe(
              Effect.provide(
                BunSocket.layerNet({ host: config.relayHost, port: config.relayPort }),
              ),
              Effect.scoped,
              Effect.tapError((e) =>
                Effect.logWarning(`Relay connection lost: ${e}. Reconnecting...`),
              ),
            ),
            RelayRetrySchedule,
          ),
          dashboardMonitorLoop.pipe(
            Effect.retry(Schedule.exponential("5 seconds").pipe(Schedule.upTo("60 seconds"))),
          ),
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(
      // Storage layers — always fresh LSM in temp dir (populated by bootstrap stream)
      Effect.provide(makeStorageLayers()),
    ),
).pipe(Command.withDescription("Start the Gerolamino data node"));

const app = Command.make("gerolamino").pipe(
  Command.withDescription("Gerolamino: sync-to-tip Cardano data node"),
  Command.withSubcommands([start]),
);

/**
 * Build storage layers with fresh LSM BlobStore + SQLite ChainDB.
 * The bootstrap stream populates the LSM store remotely.
 */
const makeStorageLayers = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const p = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;

      const baseDir = yield* fs.makeTempDirectory({ prefix: "gerolamino-" });
      const lsmDir = p.join(baseDir, "lsm");
      yield* fs.makeDirectory(lsmDir, { recursive: true });

      const blobStoreLayer = layerLsm(lsmDir);
      const sqlClientLayer = layerBunSqlClient({ filename: p.join(baseDir, "chain.db") });

      const chainDbLayer = ChainDBLive.pipe(
        Layer.provide(Layer.merge(blobStoreLayer, sqlClientLayer)),
      );

      return Layer.mergeAll(chainDbLayer, sqlClientLayer, blobStoreLayer);
    }),
  );

// SlotClock from Config env vars, falling back to PREPROD_CONFIG defaults.
const slotClockLayer = Layer.effect(
  SlotClock,
  SlotClockLayerFromConfig.pipe(Effect.catch(() => SlotClockLive(PREPROD_CONFIG))),
);
const peerManagerLayer = Layer.effect(PeerManager, PeerManagerLive).pipe(
  Layer.provide(slotClockLayer),
);

// Consensus + clock + peers — storage is provided per-command from CLI config.
// BunWorker.layer provides WorkerPlatform + Spawner for Effect Worker pool.
// Each worker spawns crypto-worker.ts in a separate OS thread for true WASM parallelism.
const workerLayer = BunWorker.layer(
  (_id) => new Worker(new URL("../../../packages/consensus/src/crypto-worker.ts", import.meta.url)),
);

const consensusLayers = Layer.mergeAll(
  ConsensusEngineWithWorkerCrypto(workerLayer),
  slotClockLayer,
  peerManagerLayer,
);

app.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(consensusLayers),
  Effect.provide(Socket.layerWebSocketConstructorGlobal),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
