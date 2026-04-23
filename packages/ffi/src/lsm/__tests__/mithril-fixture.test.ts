/**
 * Mithril V2LSM fixture smoke test — continuous-testing hook #1.
 *
 * First end-to-end validation of the Phase 0f pipeline:
 *   `nix run .#download-mithril-lsm-snapshot -- preprod $MITHRIL_FIXTURE_PATH`
 * produces `$MITHRIL_FIXTURE_PATH/lsm/` (a V2LSM session). The snapshot name
 * inside the session is `<slot>_lsm` (matches `ouroboros-consensus` §
 * Snapshots.hs `snapshotToDirName`, then committed by mithril-client at
 * `snapshot_converter.rs:763`). The SnapshotLabel is `"UTxO table"`
 * (matches `LSM.hs:547`, also the default in `layerLsmFromSnapshot`).
 *
 * Gated on LIBLSM_BRIDGE_PATH (native lib present) AND
 * MITHRIL_FIXTURE_ENABLED (opt-in). The fixture path defaults to
 * `./mithril-fixture` to match the Nix app default.
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, Option } from "effect";
import { BlobStore } from "../../blob-store.ts";
import { layerLsmFromSnapshot } from "../layer-lsm";
import * as fs from "node:fs";
import * as path from "node:path";

const LIBLSM_BRIDGE_PATH = process.env["LIBLSM_BRIDGE_PATH"];
const MITHRIL_FIXTURE_ENABLED = process.env["MITHRIL_FIXTURE_ENABLED"] === "true";
const MITHRIL_FIXTURE_PATH = process.env["MITHRIL_FIXTURE_PATH"] ?? "./mithril-fixture";

const skip = !LIBLSM_BRIDGE_PATH || !MITHRIL_FIXTURE_ENABLED;

/** Return the single `<slot>_lsm` snapshot under `$session/snapshots/`. */
const discoverSnapshotName = (sessionDir: string): string => {
  const snapshotsDir = path.join(sessionDir, "snapshots");
  const entries = fs
    .readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith("_lsm"))
    .map((e) => e.name);
  if (entries.length !== 1)
    throw new Error(
      `expected exactly one <slot>_lsm snapshot under ${snapshotsDir}, found: ${entries.join(", ")}`,
    );
  return entries[0]!;
};

describe.skipIf(skip)("Mithril V2LSM fixture", () => {
  const sessionDir = path.join(MITHRIL_FIXTURE_PATH, "lsm");

  it.effect("opens the converted snapshot via layerLsmFromSnapshot", () =>
    Effect.gen(function* () {
      const snapshotName = discoverSnapshotName(sessionDir);
      const layer = layerLsmFromSnapshot(sessionDir, snapshotName);

      // Issuing any query is enough to exercise the full stack:
      // GHC RTS boot → lsm_session_open → lsm_snapshot_restore → lookup.
      // A byte-exact check against real preprod data lives in the golden
      // vector test below.
      const result = yield* Effect.gen(function* () {
        const store = yield* BlobStore;
        return yield* store.has(new Uint8Array([0x00]));
      }).pipe(Effect.provide(layer));

      expect(typeof result).toBe("boolean");
    }),
  );

  it.effect(
    "matches committed golden UTxO bytes when fixtures/mithril-preprod-golden.json is present",
    () =>
      Effect.gen(function* () {
        const goldenPath = path.join(__dirname, "fixtures", "mithril-preprod-golden.json");
        if (!fs.existsSync(goldenPath)) {
          // Golden file is captured after first deploy of the self-hosted
          // Mithril aggregator (Phase 0f-iii). Absent in-repo until then; when
          // present, we assert byte-exact round-trip through the V2LSM layer.
          return;
        }

        const golden = JSON.parse(fs.readFileSync(goldenPath, "utf-8")) as {
          txIn: string;
          txOut: string;
        };
        const snapshotName = discoverSnapshotName(sessionDir);
        const layer = layerLsmFromSnapshot(sessionDir, snapshotName);

        const result = yield* Effect.gen(function* () {
          const store = yield* BlobStore;
          const key = Uint8Array.fromHex(golden.txIn);
          return Option.getOrUndefined(yield* store.get(key));
        }).pipe(Effect.provide(layer));

        expect(result).toEqual(Uint8Array.fromHex(golden.txOut));
      }),
  );
});
