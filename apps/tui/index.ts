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
import { Config, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import path from "node:path";
import {
  getNodeStatus,
  ConsensusEngineWithWasmCrypto,
  SlotClock,
  SlotClockLive,
  PREPROD_CONFIG,
  PeerManager,
  PeerManagerLive,
} from "consensus";
import {
  ChainDB,
  ChainDBLive,
  SqliteDrizzle,
  layerBunSqlClient,
  runMigrations,
} from "storage";
import { layerLsmFromSnapshot } from "lsm-tree";

const start = Command.make(
  "start",
  {
    snapshotPath: Flag.directory("snapshot-path").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("Path to Mithril V2LSM snapshot directory"),
      Flag.withFallbackConfig(Config.string("SNAPSHOT_PATH")),
    ),
    snapshotName: Flag.string("snapshot-name").pipe(
      Flag.withDescription("LSM snapshot name to restore"),
      Flag.withDefault("latest"),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      yield* Effect.log("Gerolamino TUI node starting...");
      yield* Effect.log(`Snapshot: ${config.snapshotPath}`);

      // Run migrations via SqlClient before using ChainDB
      yield* runMigrations;
      yield* Effect.log("Database migrations complete.");

      const status = yield* getNodeStatus;
      yield* Effect.log(`Tip: slot ${status.tipSlot} / ${status.currentSlot}`);
      yield* Effect.log(`Epoch: ${status.epochNumber}`);
      yield* Effect.log(`Sync: ${status.syncPercent}%`);
      yield* Effect.log(`GSM: ${status.gsmState}`);
      yield* Effect.log(`Peers: ${status.peerCount}`);

      yield* Effect.log("Node initialized. Connect upstream peers to begin sync.");
    }),
).pipe(
  Command.withDescription("Start the Gerolamino data node"),
);

const app = Command.make("gerolamino").pipe(
  Command.withDescription("Gerolamino: sync-to-tip Cardano data node"),
  Command.withSubcommands([start]),
);

/**
 * Build storage layers from snapshot path using SqlClient↔Drizzle proxy pattern.
 *
 * Composition:
 *   layerBunSqlClient → SqlClient
 *     → SqliteDrizzle.layerProxy → SqliteDrizzle
 *   layerLsmFromSnapshot → BlobStore
 *     → ChainDBLive → ChainDB
 *
 * SqlClient is also exposed for runMigrations in the startup Effect.
 * Effect's layer memoization ensures a single Database connection is shared.
 */
const makeStorageLayers = (snapshotPath: string, snapshotName: string) => {
  const lsmDir = path.join(snapshotPath, "lsm");
  const dbPath = path.join(snapshotPath, "chain.db");

  const blobStoreLayer = layerLsmFromSnapshot(lsmDir, snapshotName);
  const sqlClientLayer = layerBunSqlClient({ filename: dbPath });
  const drizzleLayer = SqliteDrizzle.layerProxy.pipe(Layer.provide(sqlClientLayer));

  const chainDbLayer = ChainDBLive.pipe(
    Layer.provide(Layer.merge(blobStoreLayer, drizzleLayer)),
  );

  // Merge ChainDB + SqlClient — SqlClient needed for runMigrations in startup.
  // Layer memoization shares the single bun:sqlite connection.
  return Layer.merge(chainDbLayer, sqlClientLayer);
};

const slotClockLayer = Layer.effect(SlotClock, SlotClockLive(PREPROD_CONFIG));
const peerManagerLayer = Layer.effect(PeerManager, PeerManagerLive).pipe(
  Layer.provide(slotClockLayer),
);

// Stub ChainDB + SqlClient until V2LSM snapshot conversion is available.
// Once V2LSM is ready, replace with: makeStorageLayers(snapshotPath, snapshotName)
const stubStorageLayers = (() => {
  const { Stream } = require("effect");
  const stubChainDb = Layer.succeed(ChainDB, {
    getBlock: () => Effect.succeed(undefined),
    getBlockAt: () => Effect.succeed(undefined),
    getTip: Effect.succeed(undefined),
    getImmutableTip: Effect.succeed(undefined),
    addBlock: () => Effect.void,
    rollback: () => Effect.void,
    getSuccessors: () => Effect.succeed([]),
    streamFrom: () => Stream.empty,
    promoteToImmutable: () => Effect.void,
    garbageCollect: () => Effect.void,
    writeLedgerSnapshot: () => Effect.void,
    readLatestLedgerSnapshot: Effect.succeed(undefined),
  });
  // Stub SqlClient layer for runMigrations (uses in-memory DB)
  const stubSqlClient = layerBunSqlClient({ filename: ":memory:" });
  return Layer.merge(stubChainDb, stubSqlClient);
})();

const nodeLayers = Layer.mergeAll(
  ConsensusEngineWithWasmCrypto,
  slotClockLayer,
  peerManagerLayer,
  stubStorageLayers,
);

app.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(nodeLayers),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
