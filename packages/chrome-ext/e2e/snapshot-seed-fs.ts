/**
 * Node-side Mithril V2LSM snapshot walker for Playwright OPFS seeding.
 *
 * Mirrors `walkSnapshotDirectoryForBrowserUpload` in `packages/bootstrap` —
 * skips `immutable/` (relay ChainSync supplies blocks) and sorts upload order.
 *
 * Uses Effect `FileSystem`, `Path`, and `Path.fromFileUrl` + `URL` for
 * module resolution (no `node:fs` / `node:path` / `node:url`).
 */
import { BunFileSystem } from "@effect/platform-bun";
import { Config, Effect, FileSystem, Layer, Option, Path } from "effect";
import {
  IMMUTABLE_DIR,
  REQUIRED_LSM_ENTRIES,
  REQUIRED_TOP_LEVEL,
  snapshotUploadPriority,
} from "bootstrap";

export type SnapshotFileOnDisk = {
  readonly opfsPath: string;
  readonly absolutePath: string;
  readonly size: number;
};

/** Bun-backed platform layer for E2E snapshot seeding. */
export const E2eFsLayer = Layer.mergeAll(BunFileSystem.layer, Path.layer);

export type E2eFsServices = FileSystem.FileSystem | Path.Path;

class SnapshotSeedError extends Error {
  readonly _tag = "SnapshotSeedError";
  constructor(message: string) {
    super(message);
    this.name = "SnapshotSeedError";
  }
}

/** Directory containing this module (`e2e/`), via `Path.fromFileUrl` + `URL`. */
const e2eModuleDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  const moduleFile = yield* path.fromFileUrl(new URL(import.meta.url));
  return path.dirname(moduleFile);
});

/** Default dev snapshot (same tree as `apps/tui --snapshot-path`). */
export const defaultDevenvSnapshotPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const e2eDir = yield* e2eModuleDir;
  return path.resolve(e2eDir, "..", "..", "..", ".devenv", "state", "db");
});

const countImmutableChunks = (immutableDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(immutableDir);
    return entries.filter((name) => name.endsWith(".chunk")).length;
  }).pipe(Effect.catch(() => Effect.succeed(0)));

const walkInto = (
  dir: string,
  prefix: string,
  out: Array<SnapshotFileOnDisk>,
  skipRootDirs: ReadonlySet<string>,
): Effect.Effect<void, SnapshotSeedError, E2eFsServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(dir).pipe(
      Effect.mapError((cause) => new SnapshotSeedError(`readDirectory(${dir}): ${String(cause)}`)),
    );
    for (const name of entries) {
      if (prefix === "" && skipRootDirs.has(name)) continue;
      const absolute = path.join(dir, name);
      const opfsPath = prefix === "" ? name : `${prefix}/${name}`;
      const info = yield* fs.stat(absolute).pipe(
        Effect.mapError((cause) => new SnapshotSeedError(`stat(${absolute}): ${String(cause)}`)),
      );
      if (info.type === "Directory") {
        yield* walkInto(absolute, opfsPath, out, skipRootDirs);
      } else if (info.type === "File") {
        out.push({ opfsPath, absolutePath: absolute, size: Number(info.size) });
      }
    }
  });

/** Validate top-level + `lsm/` layout before seeding (~1 GiB uploads). */
export const assertSnapshotLayout = (
  snapshotPath: string,
): Effect.Effect<void, SnapshotSeedError, E2eFsServices> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const top = yield* fs.readDirectory(snapshotPath).pipe(
      Effect.mapError(
        (cause) => new SnapshotSeedError(`readDirectory(${snapshotPath}): ${String(cause)}`),
      ),
    );
    const topLevel = new Set(top);
    const missingTop = REQUIRED_TOP_LEVEL.filter((e) => !topLevel.has(e));
    if (missingTop.length > 0) {
      return yield* Effect.fail(
        new SnapshotSeedError(
          `Not a V2LSM snapshot at ${snapshotPath} — missing: ${missingTop.join(", ")}`,
        ),
      );
    }
    const lsmPath = path.join(snapshotPath, "lsm");
    const lsm = yield* fs.readDirectory(lsmPath).pipe(
      Effect.mapError((cause) => new SnapshotSeedError(`readDirectory(${lsmPath}): ${String(cause)}`)),
    );
    const lsmEntries = new Set(lsm);
    const missingLsm = REQUIRED_LSM_ENTRIES.filter((e) => !lsmEntries.has(e));
    if (missingLsm.length > 0) {
      return yield* Effect.fail(
        new SnapshotSeedError(`lsm/ missing required entries: ${missingLsm.join(", ")}`),
      );
    }
  });

/** Skip frozen snapshot blobs — live session is under `lsm/active/`. */
const isE2eOpfsSnapshotBlob = (opfsPath: string): boolean =>
  opfsPath.startsWith("lsm/snapshots/") && opfsPath !== "lsm/snapshots/.lock";

/**
 * Files to seed extension OPFS for Mithril E2E (~30 MiB vs ~1 GiB full tree).
 * Keeps `protocolMagicId`, `ledger/`, `lsm/active/`, `lsm/metadata`; drops
 * `immutable/` and heavy `lsm/snapshots/*` keyops (relay supplies blocks).
 */
export const listSnapshotFilesForE2eOpfsSeed = (
  snapshotPath: string,
): Effect.Effect<
  {
    readonly files: ReadonlyArray<SnapshotFileOnDisk>;
    readonly skippedImmutableCount: number;
    readonly skippedSnapshotBlobCount: number;
  },
  SnapshotSeedError,
  E2eFsServices
> =>
  Effect.gen(function* () {
    const { files, skippedImmutableCount } = yield* listSnapshotFilesForUpload(snapshotPath);
    const slim = files.filter((f) => !isE2eOpfsSnapshotBlob(f.opfsPath));
    const skippedSnapshotBlobCount = files.length - slim.length;
    return { files: slim, skippedImmutableCount, skippedSnapshotBlobCount };
  });

/** List files to copy into extension OPFS (excludes `immutable/` by default). */
export const listSnapshotFilesForUpload = (
  snapshotPath: string,
  options?: { readonly includeImmutable?: boolean },
): Effect.Effect<
  { readonly files: ReadonlyArray<SnapshotFileOnDisk>; readonly skippedImmutableCount: number },
  SnapshotSeedError,
  E2eFsServices
> =>
  Effect.gen(function* () {
    yield* assertSnapshotLayout(snapshotPath);
    const path = yield* Path.Path;
    const includeImmutable = options?.includeImmutable === true;
    const skippedImmutableCount = includeImmutable
      ? 0
      : yield* countImmutableChunks(path.join(snapshotPath, IMMUTABLE_DIR));
    const files: Array<SnapshotFileOnDisk> = [];
    yield* walkInto(
      snapshotPath,
      "",
      files,
      includeImmutable ? new Set() : new Set([IMMUTABLE_DIR]),
    );
    files.sort(
      (a, b) =>
        snapshotUploadPriority(a.opfsPath) - snapshotUploadPriority(b.opfsPath) ||
        a.opfsPath.localeCompare(b.opfsPath),
    );
    return { files, skippedImmutableCount };
  });

/** Resolve `GEROLAMINO_SNAPSHOT_PATH` or repo `.devenv/state/db`. */
export const resolveE2eSnapshotPath: Effect.Effect<string | undefined, never, E2eFsServices> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fromConfig = yield* Config.string("GEROLAMINO_SNAPSHOT_PATH").pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const resolved = yield* Option.match(fromConfig, {
      onNone: () => defaultDevenvSnapshotPath,
      onSome: (raw) => {
        const trimmed = raw.trim();
        return trimmed.length > 0
          ? Effect.succeed(path.resolve(trimmed))
          : defaultDevenvSnapshotPath;
      },
    });
    const exists = yield* fs.exists(resolved);
    return exists ? resolved : undefined;
  }).pipe(Effect.orDie);

export const formatSnapshotSeedSummary = (
  snapshotPath: string,
  files: ReadonlyArray<SnapshotFileOnDisk>,
  skippedImmutableCount: number,
  skippedSnapshotBlobCount = 0,
): string => {
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const mib = (totalBytes / 1024 / 1024).toFixed(1);
  const imm =
    skippedImmutableCount > 0
      ? `; skipped ${skippedImmutableCount} immutable/*.chunk (relay sync)`
      : "";
  const snap =
    skippedSnapshotBlobCount > 0
      ? `; skipped ${skippedSnapshotBlobCount} lsm/snapshots/* blobs (active session only)`
      : "";
  return `[e2e] seeding ${files.length} files (${mib} MiB) from ${snapshotPath}${imm}${snap}`;
};
