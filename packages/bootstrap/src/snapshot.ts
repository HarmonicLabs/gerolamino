/**
 * Mithril V2LSM snapshot helpers.
 *
 * Two host environments call into this module:
 *
 *   - **Node / Bun (`apps/tui`)** — reads the snapshot directly from
 *     disk via Effect's `FileSystem` service. The TUI's `--snapshot-path`
 *     flag points at a directory laid out as a Mithril V2LSM dump;
 *     consensus initialises the lsm-tree session against that path and
 *     resumes relay sync from the snapshot's tip.
 *
 *   - **Browser (`packages/chrome-ext`)** — the user drag-and-drops a
 *     snapshot folder onto the popup. The component walks the
 *     `FileSystemDirectoryHandle` (File System Access API), streams
 *     bytes to the offscreen → lsm-worker pipeline, and the worker
 *     writes them into OPFS. The same expected-layout constants used
 *     by the Node reader gate "what counts as a valid snapshot" on the
 *     popup side.
 *
 * Expected snapshot directory structure (canonical Mithril V2LSM):
 *
 *   {snapshotPath}/
 *     protocolMagicId       — text file with network magic number
 *     ledger/{slot}/
 *       state               — ExtLedgerState CBOR bytes
 *       meta                — optional metadata file
 *     immutable/
 *       *.chunk             — ImmutableDB block chunk files
 *     lsm/                  — V2LSM table files (opened via lsm-tree)
 *       active/
 *       metadata
 *       snapshots/{slot}/   — snapshot tables
 *
 * The bootstrap server (formerly `apps/bootstrap`) used to read this
 * structure and stream it over WebSocket to chrome-ext; that path is
 * gone. Chrome-ext now ingests the snapshot directly via drag-drop +
 * OPFS, sharing the same layout constants below.
 */
import { Effect, FileSystem, Path, Schema } from "effect";

// ───────────────────────────────────────────────────────────────────
// Layout constants — host-agnostic. Imported by both the Node FS
// reader below and the browser-side walker in `./walker.ts`.
// ───────────────────────────────────────────────────────────────────

/** Top-level entries every well-formed Mithril V2LSM snapshot has. */
export const REQUIRED_TOP_LEVEL = ["protocolMagicId", "ledger", "lsm"] as const;

/** Entries under `lsm/` that lsm-tree's `openSession` expects. */
export const REQUIRED_LSM_ENTRIES = ["active", "metadata", "snapshots"] as const;

/** Slot-directory pattern — matches both native cardano-node dumps
 *  (`ledger/<slot>`) and Mithril-converted snapshots
 *  (`ledger/<slot>_lsm`). The numeric prefix IS the slot number. */
export const SLOT_DIR_RE = /^(\d+)(?:_lsm)?$/;

/** Network magic → readable name. Used by `readNodeDbMeta` when the
 *  snapshot didn't ship a `protocolMagicId` file (cardano-node DB
 *  layout). */
export const NETWORK_MAGIC: Record<string, number> = {
  preprod: 1,
  preview: 2,
  mainnet: 764824073,
};

// ───────────────────────────────────────────────────────────────────
// Schema types — shared between host environments.
// ───────────────────────────────────────────────────────────────────

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

/** Hard-link `src` → `dst`, falling back to copy on cross-device link failure. */
const linkOrCopy = (
  fs: FileSystem.FileSystem,
  src: string,
  dst: string,
) => fs.link(src, dst).pipe(Effect.catch(() => fs.copyFile(src, dst)));

// ───────────────────────────────────────────────────────────────────
// Node / Bun reader — Effect `FileSystem` service. Used by apps/tui's
// `--snapshot-path` flag.
// ───────────────────────────────────────────────────────────────────

/**
 * Read snapshot metadata from a Mithril V2LSM snapshot directory.
 *
 * Discovers the snapshot slot from the `ledger/` subdirectory,
 * reads `protocolMagicId`, and counts immutable chunk files.
 */
export const readSnapshotMeta = (snapshotPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;

    const ledgerBase = p.join(snapshotPath, "ledger");
    const ledgerEntries = yield* fs.readDirectory(ledgerBase);

    // Prefer plain-digit form (native cardano-node V2LSM dump) when
    // both `<slot>` and `<slot>_lsm` siblings exist; fall back to
    // `_lsm` for Mithril-converted-only snapshots.
    const slotMatches = ledgerEntries
      .map((e) => ({ entry: e, match: SLOT_DIR_RE.exec(e) }))
      .filter((x): x is { entry: string; match: RegExpExecArray } => x.match !== null);
    const primary = slotMatches.find((x) => x.entry === x.match[1]) ?? slotMatches[0];
    if (!primary) {
      return yield* new SnapshotReadError({
        message: "No snapshot slot directory found in ledger/",
        cause: `entries: ${ledgerEntries.join(", ")}`,
      });
    }
    const snapshotSlot = BigInt(primary.match[1]!);

    const ledgerDir = p.join(ledgerBase, primary.entry);
    const immutableDir = p.join(snapshotPath, "immutable");
    const lsmDir = p.join(snapshotPath, "lsm");

    const protocolMagic = parseInt(
      new TextDecoder().decode(yield* fs.readFile(p.join(snapshotPath, "protocolMagicId"))),
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
    return yield* fs.readFile(p.join(meta.ledgerDir, "state"));
  });

/**
 * Find the latest LSM snapshot name in a `lsm/snapshots/` directory.
 * Returns the highest-numbered slot name.
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
      return yield* new SnapshotReadError({
        message: "No numeric snapshot directories found in lsm/snapshots/",
        cause: `entries: ${entries.join(", ")}`,
      });
    }
    return numericEntries[0]!;
  });

/**
 * Prepare an LSM session directory by hard-linking snapshot files
 * from a running cardano-node's lsm/ directory into a temp session dir.
 *
 * Necessary because the running node holds an OS file lock on
 * `lsm/lock`. The temp dir mirrors the snapshot structure with hard-
 * links (cheap) or copies (cross-device fallback).
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
      yield* linkOrCopy(fs, src, dst);
    }

    yield* linkOrCopy(fs, p.join(sourceLsmDir, "metadata"), p.join(tempDir, "metadata"));

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
 * Unlike Mithril snapshots, node DBs don't ship `protocolMagicId`, so
 * the network magic must be supplied explicitly.
 */
export const readNodeDbMeta = (dbPath: string, network: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const p = yield* Path.Path;

    const protocolMagic = NETWORK_MAGIC[network];
    if (protocolMagic === undefined) {
      return yield* new SnapshotReadError({
        message: `Unknown network: ${network}`,
        cause: `Valid networks: ${Object.keys(NETWORK_MAGIC).join(", ")}`,
      });
    }

    const immutableDir = p.join(dbPath, "immutable");
    const nodeLsmDir = p.join(dbPath, "lsm");

    const snapshotName = yield* findLatestLsmSnapshot(nodeLsmDir);
    const snapshotSlot = BigInt(snapshotName);
    const sessionDir = yield* prepareLsmSession(nodeLsmDir, snapshotName);

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
