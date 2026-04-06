/**
 * Gerolamino TUI node — sync-to-tip Cardano data node.
 *
 * Bootstraps from a Mithril V2LSM snapshot, validates headers via
 * consensus layer, stores data via BlobStore (LSM) + SQL.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { getSyncState, ConsensusEngineWithBunCrypto } from "consensus";
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

      // Get current sync state
      const state = yield* getSyncState;
      yield* Effect.log(`Tip: ${state.tip ? `slot ${state.tip.slot}` : "genesis"}`);
      yield* Effect.log(`GSM: ${state.gsmState}`);
      yield* Effect.log(`Blocks processed: ${state.blocksProcessed}`);

      // TODO: connect to upstream Cardano relay node via miniprotocols
      // TODO: run ChainSync and BlockFetch
      // TODO: process blocks through syncFromStream
      yield* Effect.log("Node initialized. Sync not yet connected to upstream.");
    }),
).pipe(
  Command.withDescription("Start the Gerolamino data node"),
);

const app = Command.make("gerolamino").pipe(
  Command.withDescription("Gerolamino: in-browser Cardano node"),
  Command.withSubcommands([start]),
);

app.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
