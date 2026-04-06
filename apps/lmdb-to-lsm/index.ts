/**
 * Mithril snapshot format converter: V1LMDB → V2LSM.
 *
 * Thin wrapper around the Haskell snapshot-converter binary from
 * ouroboros-consensus. The Haskell binary handles the actual conversion
 * with full parity (correct CRC, metadata, LSM run files).
 *
 * This wrapper provides:
 *   - Effect CLI interface consistent with the rest of the monorepo
 *   - Integration with the devenv task pipeline
 *   - Logging via Effect
 *
 * The snapshot-converter binary is built via:
 *   nix build .#snapshot-converter
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { execSync } from "node:child_process";

const convert = Command.make(
  "convert",
  {
    inputLmdb: Flag.directory("input-lmdb").pipe(
      Flag.withDescription("Path to LMDB snapshot directory (named after slot)"),
    ),
    outputLsmSnapshot: Flag.directory("output-lsm-snapshot").pipe(
      Flag.withDescription("Path for LSM snapshot output (named after slot)"),
    ),
    outputLsmDatabase: Flag.directory("output-lsm-database").pipe(
      Flag.withDescription("Path for LSM database directory"),
    ),
    configPath: Flag.file("config").pipe(
      Flag.withDescription("Path to cardano-node config JSON"),
      Flag.withFallbackConfig(Config.string("CARDANO_CONFIG")),
    ),
    converterBin: Flag.file("converter-bin").pipe(
      Flag.withDescription("Path to snapshot-converter binary"),
      Flag.withDefault("snapshot-converter"),
      Flag.withFallbackConfig(Config.string("SNAPSHOT_CONVERTER_BIN")),
    ),
  },
  (cfg) =>
    Effect.gen(function* () {
      yield* Effect.log("Starting LMDB → V2LSM conversion...");
      yield* Effect.log(`  Input LMDB:        ${cfg.inputLmdb}`);
      yield* Effect.log(`  Output LSM snapshot: ${cfg.outputLsmSnapshot}`);
      yield* Effect.log(`  Output LSM database: ${cfg.outputLsmDatabase}`);
      yield* Effect.log(`  Config:            ${cfg.configPath}`);
      yield* Effect.log(`  Converter:         ${cfg.converterBin}`);

      const cmd = [
        cfg.converterBin,
        "--input-lmdb",
        cfg.inputLmdb,
        "--output-lsm-snapshot",
        cfg.outputLsmSnapshot,
        "--output-lsm-database",
        cfg.outputLsmDatabase,
        "--config",
        cfg.configPath,
      ].join(" ");

      yield* Effect.try({
        try: () => execSync(cmd, { stdio: "inherit" }),
        catch: (cause) => new Error(`snapshot-converter failed: ${cause}`),
      });

      yield* Effect.log("Conversion complete.");
    }),
).pipe(
  Command.withDescription("Convert LMDB snapshot to V2LSM format"),
  Command.withExamples([
    {
      command:
        "lmdb-to-lsm convert --input-lmdb ledger/123456 --output-lsm-snapshot ledger/123456_lsm --output-lsm-database lsm --config config.json",
      description: "Convert a Mithril snapshot to V2LSM",
    },
  ]),
);

const app = Command.make("lmdb-to-lsm").pipe(
  Command.withDescription(
    "Mithril snapshot converter: V1LMDB → V2LSM\n" +
      "Wraps the Haskell snapshot-converter from ouroboros-consensus.\n" +
      "Output can bootstrap both our node and the reference Haskell cardano-node.",
  ),
  Command.withSubcommands([convert]),
);

app.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
