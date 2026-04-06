/**
 * Gerolamino TUI node — sync-to-tip Cardano data node.
 *
 * Bootstraps from a Mithril V2LSM snapshot, validates headers via
 * consensus layer, stores data via BlobStore (LSM) + SQL.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
  getNodeStatus,
  ConsensusEngineWithBunCrypto,
  SlotClock,
  SlotClockLive,
  PREPROD_CONFIG,
  PeerManager,
  PeerManagerLive,
} from "consensus";
import { ImmutableDB, VolatileDB, LedgerDB, BlobStore } from "storage";
import { layerLsm } from "lsm-tree";

const start = Command.make(
  "start",
  {
    snapshotPath: Flag.directory("snapshot-path").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("Path to Mithril V2LSM snapshot directory"),
      Flag.withFallbackConfig(Config.string("SNAPSHOT_PATH")),
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

// Stub layers for now — will be replaced with real implementations
const stubImmutableDb = Layer.succeed(ImmutableDB, {
  appendBlock: () => Effect.void,
  readBlock: () => Effect.succeed(undefined),
  getTip: Effect.succeed(undefined),
  streamBlocks: () => {
    const { Stream } = require("effect");
    return Stream.empty;
  },
});

const stubVolatileDb = Layer.succeed(VolatileDB, {
  addBlock: () => Effect.void,
  getBlock: () => Effect.succeed(undefined),
  getSuccessors: () => Effect.succeed([]),
  garbageCollect: () => Effect.void,
});

const stubLedgerDb = Layer.succeed(LedgerDB, {
  writeSnapshot: () => Effect.void,
  readLatestSnapshot: Effect.succeed(undefined),
});

const slotClockLayer = Layer.effect(SlotClock, SlotClockLive(PREPROD_CONFIG));
const peerManagerLayer = Layer.effect(PeerManager, PeerManagerLive).pipe(
  Layer.provide(slotClockLayer),
);

const nodeLayers = Layer.mergeAll(
  ConsensusEngineWithBunCrypto,
  slotClockLayer,
  peerManagerLayer,
  stubImmutableDb,
  stubVolatileDb,
  stubLedgerDb,
);

app.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(nodeLayers),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
