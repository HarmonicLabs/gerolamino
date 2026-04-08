/**
 * Gerolamino TUI node — sync-to-tip Cardano data node.
 *
 * Bootstraps from a Mithril V2LSM snapshot, validates headers via
 * consensus layer, stores data via BlobStore (LSM) + SQL.
 *
 * SQL access follows the SqlClient↔Drizzle proxy bridge pattern:
 *   layerBunSqlClient → SqlClient
 *     → SqliteDrizzle.layerProxy (consumes SqlClient) → SqliteDrizzle
 *     → runMigrations (consumes SqlClient) — creates tables
 *     → ChainDBLive (consumes BlobStore + SqliteDrizzle) → ChainDB
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Config, Effect, Layer, Option, Schedule } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import path from "node:path";
import os from "node:os";
import {
  getNodeStatus,
  monitorLoop,
  ConsensusEngineWithWasmCrypto,
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
} from "consensus";
import type { LedgerView } from "consensus";
import { decodeExtLedgerState } from "ledger/lib/state/new-epoch-state.ts";
import { readSnapshotMeta, readLedgerStateBytes } from "bootstrap";
import {
  ChainDBLive,
  SqliteDrizzle,
  layerBunSqlClient,
  runMigrations,
  BlobStoreInMemory,
} from "storage";
import { layerLsmFromSnapshot } from "lsm-tree";

const start = Command.make(
  "start",
  {
    snapshotPath: Flag.directory("snapshot-path").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("Path to Mithril V2LSM snapshot directory"),
      Flag.withFallbackConfig(Config.string("SNAPSHOT_PATH")),
      Flag.optional,
    ),
    snapshotName: Flag.string("snapshot-name").pipe(
      Flag.withDescription("LSM snapshot name to restore"),
      Flag.withDefault("latest"),
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

      const snapshotPath = Option.getOrUndefined(config.snapshotPath);
      if (snapshotPath) {
        yield* Effect.log(`Snapshot: ${snapshotPath}`);
      } else {
        yield* Effect.log("No snapshot — using in-memory BlobStore (sync from origin)");
      }
      yield* Effect.log(`Relay: ${config.relayHost}:${config.relayPort} (${config.network})`);

      // Run migrations via SqlClient before using ChainDB
      yield* runMigrations;
      yield* Effect.log("Database migrations complete.");

      // Bootstrap from Mithril snapshot when available.
      // Reads ledger state, decodes ExtLedgerState, extracts LedgerView + nonces.
      let ledgerView: LedgerView;
      let snapshotState:
        | { tip: { slot: bigint; hash: Uint8Array } | undefined; nonces: ReturnType<typeof extractNonces> }
        | undefined;

      if (snapshotPath) {
        const meta = yield* readSnapshotMeta(snapshotPath);
        yield* Effect.log(
          `Snapshot: slot ${meta.snapshotSlot}, magic ${meta.protocolMagic}, ${meta.totalChunks} chunks`,
        );

        const stateBytes = yield* readLedgerStateBytes(meta);
        yield* Effect.log(`Ledger state: ${stateBytes.length} bytes, decoding...`);

        const extState = yield* decodeExtLedgerState(stateBytes);
        yield* Effect.log(
          `Decoded: era ${extState.currentEra}, epoch ${extState.newEpochState.epoch}, ` +
            `${extState.newEpochState.poolDistr.pools.size} pools`,
        );

        ledgerView = yield* extractLedgerView(extState);
        const nonces = extractNonces(extState);
        const tip = extractSnapshotTip(extState);
        snapshotState = { tip, nonces };

        yield* Effect.log(
          `Bootstrap: tip slot ${tip?.slot ?? "origin"}, totalStake ${ledgerView.totalStake}, ` +
            `${ledgerView.poolVrfKeys.size} VRF keys loaded`,
        );
      } else {
        // No snapshot — stub LedgerView for sync-from-origin (header validation will skip)
        ledgerView = {
          epochNonce: new Uint8Array(32),
          poolVrfKeys: new Map(),
          poolStake: new Map(),
          totalStake: 0n,
          activeSlotsCoeff: 0.05,
          maxKesEvolutions: 62,
        };
      }

      const status = yield* getNodeStatus;
      yield* Effect.log(`Tip: slot ${status.tipSlot} / ${status.currentSlot}`);
      yield* Effect.log(`Epoch: ${status.epochNumber}`);
      yield* Effect.log(`Sync: ${status.syncPercent}%`);
      yield* Effect.log(`GSM: ${status.gsmState}`);

      const networkMagic = config.network === "mainnet" ? MAINNET_MAGIC : PREPROD_MAGIC;
      const peerId = `${config.relayHost}:${config.relayPort}`;

      // Connect to upstream relay with exponential backoff reconnection.
      // Monitor loop runs in parallel with its own error recovery.
      yield* Effect.all(
        [
          Effect.retry(
            connectToRelay(peerId, networkMagic, ledgerView, snapshotState).pipe(
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
          monitorLoop.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`Monitor error: ${cause}`).pipe(
                Effect.andThen(Effect.sleep("5 seconds")),
                Effect.andThen(monitorLoop),
              ),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(
      // Storage layers depend on CLI config — provide inside command handler
      Effect.provide(makeStorageLayers(
        Option.getOrUndefined(config.snapshotPath),
        config.snapshotName,
      )),
    ),
).pipe(
  Command.withDescription("Start the Gerolamino data node"),
);

const app = Command.make("gerolamino").pipe(
  Command.withDescription("Gerolamino: sync-to-tip Cardano data node"),
  Command.withSubcommands([start]),
);

/**
 * Build storage layers from snapshot path using SqlClient↔Drizzle proxy pattern.
 * When no snapshot is provided, uses in-memory BlobStore and a temp SQLite DB.
 */
const makeStorageLayers = (snapshotPath: string | undefined, snapshotName: string) => {
  const dbPath = snapshotPath
    ? path.join(snapshotPath, "chain.db")
    : path.join(os.tmpdir(), `gerolamino-${process.pid}.db`);

  const blobStoreLayer = snapshotPath
    ? layerLsmFromSnapshot(path.join(snapshotPath, "lsm"), snapshotName)
    : BlobStoreInMemory;

  const sqlClientLayer = layerBunSqlClient({ filename: dbPath });
  const drizzleLayer = SqliteDrizzle.layerProxy.pipe(Layer.provide(sqlClientLayer));

  const chainDbLayer = ChainDBLive.pipe(
    Layer.provide(Layer.merge(blobStoreLayer, drizzleLayer)),
  );

  return Layer.merge(chainDbLayer, sqlClientLayer);
};

// SlotClock from Config env vars, falling back to PREPROD_CONFIG defaults.
const slotClockLayer = Layer.effect(SlotClock, SlotClockLayerFromConfig.pipe(
  Effect.catch(() => SlotClockLive(PREPROD_CONFIG)),
));
const peerManagerLayer = Layer.effect(PeerManager, PeerManagerLive).pipe(
  Layer.provide(slotClockLayer),
);

// Consensus + clock + peers — storage is provided per-command from CLI config.
const consensusLayers = Layer.mergeAll(
  ConsensusEngineWithWasmCrypto,
  slotClockLayer,
  peerManagerLayer,
);

app.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(consensusLayers),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
