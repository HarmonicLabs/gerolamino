/**
 * E2E test: import real LMDB snapshot data into LSM BlobStore.
 *
 * Requires:
 *   - LIBLSM_PATH pointing to liblsm-ffi.so
 *   - LIBLMDB_PATH pointing to liblmdb.so
 *   - SNAPSHOT_PATH pointing to a Mithril snapshot with LMDB tables
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect, Stream } from "effect";
import { BlobStore } from "../../../storage/src/blob-store/service";
import { PREFIX_UTXO } from "../../../storage/src/blob-store/keys";
import { layerLsm } from "../layer-lsm";
import { importLmdbToBlob } from "../import-lmdb";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LIBLSM_PATH = process.env["LIBLSM_PATH"];
const LIBLMDB_PATH = process.env["LIBLMDB_PATH"];
const SNAPSHOT_PATH = process.env["SNAPSHOT_PATH"];
const skip = !LIBLSM_PATH || !LIBLMDB_PATH || !SNAPSHOT_PATH;

describe.skipIf(skip)("Import LMDB → LSM BlobStore", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsm-import-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports UTxO entries and scans them back", async () => {
    const layer = layerLsm(LIBLSM_PATH!, tmpDir);

    // Find the LMDB tables directory
    const ledgerEntries = fs.readdirSync(path.join(SNAPSHOT_PATH!, "ledger"));
    const slotDir = ledgerEntries.find((e) => !e.includes("_"))!;
    const tablesDir = path.join(SNAPSHOT_PATH!, "ledger", slotDir, "tables");

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // Import LMDB → BlobStore
        const imported = yield* importLmdbToBlob(LIBLMDB_PATH!, tablesDir);
        yield* Effect.log(`Imported ${imported} entries`);

        // Scan back and count
        const store = yield* BlobStore;
        let scanned = 0;
        yield* Stream.runForEach(
          store.scan(PREFIX_UTXO),
          (_e) => Effect.sync(() => { scanned++; }),
        );

        return { imported, scanned };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.imported).toBeGreaterThan(0);
    expect(result.scanned).toBe(result.imported);
    console.log(`✅ Imported and verified ${result.imported} UTxO entries`);
  }, 300_000); // 5 minute timeout for large snapshots
});
