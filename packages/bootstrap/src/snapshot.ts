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
    const ledgerEntries = yield* fs.readDirectory(ledgerBase).pipe(
      Effect.mapError(
        (cause) =>
          new SnapshotReadError({
            message: `Failed to read ledger directory: ${ledgerBase}`,
            cause,
          }),
      ),
    );

    // Find the primary snapshot slot directory (skip *_lsm suffixed dirs)
    const snapshotSlotStr = ledgerEntries.find((e) => !e.includes("_"));
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
        yield* fs.readFile(p.join(snapshotPath, "protocolMagicId")).pipe(
          Effect.mapError(
            (cause) =>
              new SnapshotReadError({
                message: "Failed to read protocolMagicId",
                cause,
              }),
          ),
        ),
      ),
    );

    const chunkFiles = yield* fs.readDirectory(immutableDir).pipe(
      Effect.mapError(
        (cause) =>
          new SnapshotReadError({
            message: `Failed to read immutable directory: ${immutableDir}`,
            cause,
          }),
      ),
    );
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
    return yield* fs.readFile(statePath).pipe(
      Effect.mapError(
        (cause) =>
          new SnapshotReadError({
            message: `Failed to read ledger state: ${statePath}`,
            cause,
          }),
      ),
    );
  });
