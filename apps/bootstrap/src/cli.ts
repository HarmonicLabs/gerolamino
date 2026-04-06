/**
 * CLI entry point for the Gerolamo bootstrap server.
 * Uses V2LSM snapshots via BlobStore (lsm-tree FFI).
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { readSnapshotMeta } from "./loader.ts";
import { startServer } from "./server.ts";
import { BlobStore, BlobStoreError } from "storage/blob-store/index";
import { layerLsm } from "lsm-tree";

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
      Flag.withDefault("db"),
      Flag.withFallbackConfig(Config.string("SNAPSHOT_PATH")),
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

      const meta = yield* readSnapshotMeta(config.snapshotPath);
      yield* Effect.log(
        `Snapshot: magic=${meta.protocolMagic} slot=${meta.snapshotSlot} chunks=${meta.totalChunks} lsm=${meta.lsmDir}`,
      );

      // Provide LSM BlobStore layer
      const lsmLayer = layerLsm(config.lsmLibPath, meta.lsmDir);

      yield* startServer(meta, { port: config.port, upstreamUrl }).pipe(
        Effect.provide(lsmLayer),
      );
      yield* Effect.log(`Bootstrap server ready on :${config.port}`);
    }),
).pipe(
  Command.withDescription("Start the Gerolamo bootstrap server"),
  Command.withExamples([
    { command: "bootstrap serve --lsm-lib /path/to/liblsm-ffi.so -s /data/snapshot", description: "Start with LSM" },
  ]),
);

const app = Command.make("bootstrap").pipe(
  Command.withDescription("Gerolamo Mithril bootstrap server (V2LSM)"),
  Command.withSubcommands([serve]),
);

app.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
