/**
 * CLI entry point for the Gerolamo bootstrap server.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { readSnapshotMeta } from "./loader.ts";
import { startServer } from "./server.ts";

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
    upstreamUrl: Flag.string("upstream-url").pipe(
      Flag.withDescription("Upstream Cardano node URL (e.g., tcp://host:port)"),
      Flag.withDefault("tcp://preprod-node.play.dev.cardano.org:3001"),
      Flag.withFallbackConfig(Config.string("UPSTREAM_URL")),
    ),
  },
  (config) => {
    const upstreamUrl = new URL(config.upstreamUrl);
    return readSnapshotMeta(config.snapshotPath).pipe(
      Effect.tap((meta) =>
        Effect.log(
          `Snapshot: magic=${meta.protocolMagic} slot=${meta.snapshotSlot} chunks=${meta.totalChunks} lmdb=[${meta.lmdbDatabases.join(",")}]`,
        ),
      ),
      Effect.flatMap((meta) => startServer(meta, { port: config.port, upstreamUrl })),
      Effect.tap(() => Effect.log(`Bootstrap server ready on :${config.port}`)),
    );
  },
).pipe(
  Command.withDescription("Start the Gerolamo bootstrap server"),
  Command.withExamples([
    { command: "bootstrap serve", description: "Start with defaults (preprod)" },
    {
      command: "bootstrap serve -p 8080 -s /data/mithril",
      description: "Custom port and snapshot",
    },
  ]),
);

const app = Command.make("bootstrap").pipe(
  Command.withDescription("Gerolamo Mithril bootstrap server"),
  Command.withSubcommands([serve]),
);

const program = app.pipe(Command.run({ version: "0.1.0" }));

program.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
