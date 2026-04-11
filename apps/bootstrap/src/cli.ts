/**
 * CLI entry point for the Gerolamo bootstrap server.
 * Supports two data sources:
 *   --snapshot-path: Mithril V2LSM snapshot directory
 *   --db-path:       Running cardano-node database directory
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { readSnapshotMeta, preloadLedgerFiles } from "./loader.ts";
import { readNodeDbMeta } from "bootstrap";
import { startServer } from "./server.ts";
import { layerLsm, layerLsmFromSnapshot } from "lsm-tree";

const serve = Command.make(
  "serve",
  {
    port: Flag.integer("port").pipe(
      Flag.withAlias("p"),
      Flag.withDescription("Port to listen on"),
      Flag.withDefault(3040),
      Flag.withFallbackConfig(Config.number("PORT")),
    ),
    snapshotPath: Flag.directory("snapshot-path").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("Path to Mithril snapshot directory"),
      Flag.withFallbackConfig(Config.string("SNAPSHOT_PATH")),
      Flag.optional,
    ),
    dbPath: Flag.directory("db-path").pipe(
      Flag.withAlias("d"),
      Flag.withDescription("Path to running cardano-node database directory"),
      Flag.withFallbackConfig(Config.string("NODE_DB_PATH")),
      Flag.optional,
    ),
    network: Flag.string("network").pipe(
      Flag.withAlias("n"),
      Flag.withDescription("Cardano network (preprod|mainnet)"),
      Flag.withDefault("preprod"),
      Flag.withFallbackConfig(Config.string("NETWORK")),
    ),
    lsmLibPath: Flag.file("lsm-lib").pipe(
      Flag.withDescription("Path to liblsm-ffi.so"),
      Flag.withFallbackConfig(Config.string("LIBLSM_BRIDGE_PATH")),
    ),
    upstreamUrl: Flag.string("upstream-url").pipe(
      Flag.withDescription("Upstream Cardano node URL (e.g., tcp://host:port)"),
      Flag.withDefault("tcp://preprod-node.play.dev.cardano.org:3001"),
      Flag.withFallbackConfig(Config.string("UPSTREAM_URL")),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const upstreamUrl = new URL(config.upstreamUrl);
      const snapshotPath = Option.getOrUndefined(config.snapshotPath);
      const dbPath = Option.getOrUndefined(config.dbPath);

      if (!snapshotPath && !dbPath) {
        return yield* Effect.fail(
          new Error("Either --snapshot-path or --db-path must be provided"),
        );
      }

      let lsmLayer: Layer.Layer<import("storage/blob-store/service").BlobStore, unknown>;

      if (dbPath) {
        // Cardano-node database mode
        yield* Effect.log(`Reading cardano-node database: ${dbPath} (${config.network})`);
        const { meta, snapshotName } = yield* readNodeDbMeta(dbPath, config.network);
        yield* Effect.log(
          `Node DB: magic=${meta.protocolMagic} slot=${meta.snapshotSlot} chunks=${meta.totalChunks} snapshot=${snapshotName}`,
        );
        const preloaded = yield* preloadLedgerFiles(meta);
        lsmLayer = layerLsmFromSnapshot(meta.lsmDir, snapshotName);

        yield* startServer(meta, { port: config.port, upstreamUrl }, preloaded).pipe(Effect.provide(lsmLayer));
      } else {
        // Mithril snapshot mode
        const meta = yield* readSnapshotMeta(snapshotPath!);
        yield* Effect.log(
          `Snapshot: magic=${meta.protocolMagic} slot=${meta.snapshotSlot} chunks=${meta.totalChunks} lsm=${meta.lsmDir}`,
        );
        const preloaded = yield* preloadLedgerFiles(meta);
        lsmLayer = layerLsm(meta.lsmDir);

        yield* startServer(meta, { port: config.port, upstreamUrl }, preloaded).pipe(Effect.provide(lsmLayer));
      }

      yield* Effect.log(`Bootstrap server ready on :${config.port}`);
    }),
).pipe(
  Command.withDescription("Start the Gerolamo bootstrap server"),
  Command.withExamples([
    {
      command: "bootstrap serve --lsm-lib /path/to/lib -s /data/snapshot",
      description: "Start from Mithril snapshot",
    },
    {
      command: "bootstrap serve --lsm-lib /path/to/lib -d /var/lib/cardano-node",
      description: "Start from cardano-node DB",
    },
  ]),
);

const app = Command.make("bootstrap").pipe(
  Command.withDescription("Gerolamo bootstrap server (V2LSM)"),
  Command.withSubcommands([serve]),
);

app.pipe(Command.run({ version: "0.1.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
