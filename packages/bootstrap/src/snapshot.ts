/**
 * Local snapshot reading — reads Mithril V2LSM snapshot directly from disk.
 *
 * Used by TUI node for direct bootstrap (no server needed).
 * The browser node uses the bootstrap server (apps/bootstrap) instead.
 *
 * Expected snapshot directory structure:
 *   {snapshotPath}/
 *     protocolMagicId       — text file with network magic number
 *     ledger/{slot}/
 *       state               — ExtLedgerState CBOR bytes
 *       meta                — optional metadata file
 *     immutable/
 *       *.chunk             — ImmutableDB block chunk files
 *     lsm/                  — V2LSM table files (opened via LSM FFI)
 */
import { Effect, FileSystem, Path, Schema } from "effect";

export class SnapshotMeta extends Schema.Class<SnapshotMeta>("SnapshotMeta")({
  protocolMagic: Schema.Number,
  snapshotSlot: Schema.BigInt,
  ledgerDir: Schema.String,
  immutableDir: Schema.String,
  lsmDir: Schema.String,
  totalChunks: Schema.Number,
}) {}

export class SnapshotReadError extends Schema.TaggedErrorClass<SnapshotReadError>()(
  "SnapshotReadError",
  { message: Schema.String, cause: Schema.Defect },
) {}

/**
 * Read snapshot metadata from a Mithril V2LSM snapshot directory.
 *
 * Discovers the snapshot slot from the ledger/ subdirectory,
 * reads protocolMagicId, and counts immutable chunk files.
 */
export const readSnapshotMeta = (snapshotPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;

    const ledgerBase = p.join(snapshotPath, "ledger");
    const ledgerEntries = yield* fs.readDirectory(ledgerBase);

    // Find the primary snapshot slot directory. A cardano-node V2LSM dump
    // has `ledger/<slot>` (primary) plus optional sibling directories
    // `ledger/<slot>_lsm` / `<slot>_tables`. The old filter
    // `!e.includes("_")` was too permissive — any oddly-named dir like
    // `foo_bar_baz` also slipped through. Match exact numeric-only names
    // so the slot parser below always receives a valid BigInt input.
    const SLOT_DIR = /^\d+$/;
    const snapshotSlotStr = ledgerEntries.find((e) => SLOT_DIR.test(e));
    if (!snapshotSlotStr) {
      return yield* Effect.fail(
        new SnapshotReadError({
          message: "No snapshot slot directory found in ledger/",
          cause: `entries: ${ledgerEntries.join(", ")}`,
        }),
      );
    }
    const snapshotSlot = BigInt(snapshotSlotStr);

    const ledgerDir = p.join(ledgerBase, snapshotSlotStr);
    const immutableDir = p.join(snapshotPath, "immutable");
    const lsmDir = p.join(snapshotPath, "lsm");

    const protocolMagic = parseInt(
      new TextDecoder().decode(
        yield* fs.readFile(p.join(snapshotPath, "protocolMagicId")),
      ),
    );

    const chunkFiles = yield* fs.readDirectory(immutableDir);
    const totalChunks = chunkFiles.filter((f) => f.endsWith(".chunk")).length;

    return new SnapshotMeta({
      protocolMagic,
      snapshotSlot,
      ledgerDir,
      immutableDir,
      lsmDir,
      totalChunks,
    });
  });

/**
 * Read raw ledger state bytes from a snapshot.
 * Returns the CBOR-encoded ExtLedgerState (typically 50-200MB).
 */
export const readLedgerStateBytes = (meta: SnapshotMeta) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;
    const statePath = p.join(meta.ledgerDir, "state");
    return yield* fs.readFile(statePath);
  });

// ---------- Cardano-node V2LSM database support ----------

/**
 * Network magic constants for protocol magic lookup.
 */
const NETWORK_MAGIC: Record<string, number> = {
  preprod: 1,
  mainnet: 764824073,
};

/**
 * Find the latest LSM snapshot name in a cardano-node lsm/snapshots/ directory.
 * Returns the highest-numbered slot name (e.g., "78123456").
 */
export const findLatestLsmSnapshot = (lsmDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;
    const snapshotsDir = p.join(lsmDir, "snapshots");
    const entries = yield* fs.readDirectory(snapshotsDir);
    const numericEntries = entries
      .filter((e) => /^\d+$/.test(e))
      .sort((a, b) => Number(BigInt(b) - BigInt(a)));
    if (numericEntries.length === 0) {
      return yield* Effect.fail(
        new SnapshotReadError({
          message: "No numeric snapshot directories found in lsm/snapshots/",
          cause: `entries: ${entries.join(", ")}`,
        }),
      );
    }
    return numericEntries[0]!;
  });

/**
 * Prepare an LSM session directory by hard-linking snapshot files
 * from a running cardano-node's lsm/ directory into a temp session dir.
 *
 * The running node holds an OS file lock on lsm/lock, so we cannot open
 * the session directly. Instead we create a temp dir with the same
 * snapshot structure and hard-link the immutable snapshot files.
 */
export const prepareLsmSession = (sourceLsmDir: string, snapshotName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;

    const tempDir = yield* fs.makeTempDirectory({ prefix: "lsm-session-" });

    const sourceSnapshotDir = p.join(sourceLsmDir, "snapshots", snapshotName);
    const targetSnapshotDir = p.join(tempDir, "snapshots", snapshotName);

    yield* fs.makeDirectory(p.join(tempDir, "snapshots"), { recursive: true });
    yield* fs.makeDirectory(targetSnapshotDir, { recursive: true });

    const files = yield* fs.readDirectory(sourceSnapshotDir);

    for (const file of files) {
      const src = p.join(sourceSnapshotDir, file);
      const dst = p.join(targetSnapshotDir, file);
      // Try hard-link first (fast, no copy), fall back to copyFile (cross-device)
      yield* fs.link(src, dst).pipe(Effect.catchCause(() => fs.copyFile(src, dst)));
    }

    // Copy root metadata file — required by lsm_session_open
    const rootMetaSrc = p.join(sourceLsmDir, "metadata");
    const rootMetaDst = p.join(tempDir, "metadata");
    yield* fs
      .link(rootMetaSrc, rootMetaDst)
      .pipe(Effect.catchCause(() => fs.copyFile(rootMetaSrc, rootMetaDst)));

    // Create empty active/ directory — required by lsm_session_open
    yield* fs.makeDirectory(p.join(tempDir, "active"), { recursive: true });

    return tempDir;
  });

/**
 * Read metadata from a running cardano-node's database directory.
 *
 * Expected layout:
 *   {dbPath}/
 *     immutable/*.chunk
 *     volatile/
 *     ledger/{slot}/state
 *     ledger/lsm/[lock, active/, snapshots/{slot}/]
 *
 * Unlike Mithril snapshots, node databases don't have a protocolMagicId file,
 * so the network magic must be provided explicitly.
 *
 * Returns the SnapshotMeta (pointing at a temp LSM session to avoid lock
 * contention) plus the snapshot name for layerLsmFromSnapshot.
 */
export const readNodeDbMeta = (dbPath: string, network: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;

    const protocolMagic = NETWORK_MAGIC[network];
    if (protocolMagic === undefined) {
      return yield* Effect.fail(
        new SnapshotReadError({
          message: `Unknown network: ${network}`,
          cause: `Valid networks: ${Object.keys(NETWORK_MAGIC).join(", ")}`,
        }),
      );
    }

    const immutableDir = p.join(dbPath, "immutable");
    // V2LSM stores ledger state in {database-path}/lsm (not ledger/<slot>)
    const nodeLsmDir = p.join(dbPath, "lsm");

    // Find latest LSM snapshot — its name IS the slot number
    const snapshotName = yield* findLatestLsmSnapshot(nodeLsmDir);
    const snapshotSlot = BigInt(snapshotName);
    const sessionDir = yield* prepareLsmSession(nodeLsmDir, snapshotName);

    // cardano-node V2LSM keeps ledger snapshots in {dbPath}/ledger/{slot}/
    // The slot name matches the LSM snapshot name.
    const ledgerDir = p.join(dbPath, "ledger", snapshotName);

    const chunkFiles = yield* fs.readDirectory(immutableDir);
    const totalChunks = chunkFiles.filter((f) => f.endsWith(".chunk")).length;

    const meta = new SnapshotMeta({
      protocolMagic,
      snapshotSlot,
      ledgerDir,
      immutableDir,
      lsmDir: sessionDir,
      totalChunks,
    });

    return { meta, snapshotName };
  });
