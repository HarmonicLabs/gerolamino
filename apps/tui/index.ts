/**
 * Gerolamino TUI node — sync-to-tip Cardano data node.
 *
 * Bootstraps from a Mithril V2LSM snapshot, validates headers via
 * consensus layer, stores data via BlobStore (LSM) + SQL.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import path from "node:path";
import {
  getNodeStatus,
  ConsensusEngineWithBunCrypto,
  SlotClock,
  SlotClockLive,
  PREPROD_CONFIG,
  PeerManager,
  PeerManagerLive,
} from "consensus";
import { ChainDB, ChainDBLive, SqliteDrizzle } from "storage";
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

// Build storage layers from snapshot path
const makeStorageLayers = (snapshotPath: string, snapshotName: string) => {
  const lsmDir = path.join(snapshotPath, "lsm");
  const dbPath = path.join(snapshotPath, "chain.db");

  const blobStoreLayer = layerLsmFromSnapshot(lsmDir, snapshotName);
  const sqlLayer = SqliteDrizzle.layerBun({ filename: dbPath, init: true });

  return ChainDBLive.pipe(
    Layer.provide(Layer.merge(blobStoreLayer, sqlLayer)),
  );
};

const slotClockLayer = Layer.effect(SlotClock, SlotClockLive(PREPROD_CONFIG));
const peerManagerLayer = Layer.effect(PeerManager, PeerManagerLive).pipe(
  Layer.provide(slotClockLayer),
);

// For now, use stub storage until snapshot-converter produces V2LSM output.
// Once V2LSM is available, replace with: makeStorageLayers(snapshotPath, snapshotName)
const stubChainDb = Layer.succeed(ChainDB, {
  getBlock: () => Effect.succeed(undefined),
  getBlockAt: () => Effect.succeed(undefined),
  getTip: Effect.succeed(undefined),
  getImmutableTip: Effect.succeed(undefined),
  addBlock: () => Effect.void,
  rollback: () => Effect.void,
  getSuccessors: () => Effect.succeed([]),
  streamFrom: () => {
    const { Stream } = require("effect");
    return Stream.empty;
  },
  promoteToImmutable: () => Effect.void,
  garbageCollect: () => Effect.void,
  writeLedgerSnapshot: () => Effect.void,
  readLatestLedgerSnapshot: Effect.succeed(undefined),
});

const nodeLayers = Layer.mergeAll(
  ConsensusEngineWithBunCrypto,
  slotClockLayer,
  peerManagerLayer,
  stubChainDb,
);

app.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(nodeLayers),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
