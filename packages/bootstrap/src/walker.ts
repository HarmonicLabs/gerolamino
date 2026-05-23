/**
 * Browser-side Mithril V2LSM snapshot walker.
 *
 * The chrome-ext popup uses the File System Access API to receive a
 * directory drop or `showDirectoryPicker()` result. This module
 * walks that handle and produces:
 *
 *   1. **Validation** — does the dropped tree have the expected
 *      Mithril V2LSM layout? `validateSnapshotHandle` checks for
 *      `protocolMagicId` + `ledger/` + `lsm/{active,metadata,snapshots}`.
 *      If any required entry is missing, surfaces a typed
 *      `SnapshotReadError` BEFORE the popup wastes time streaming
 *      bytes to OPFS.
 *
 *   2. **Walk** — yields `{ file, opfsPath }` pairs. For chrome-ext
 *      upload use `walkSnapshotDirectoryForBrowserUpload`, which skips
 *      the `immutable/` subtree (relay ChainSync supplies blocks) and
 *      orders files: `protocolMagicId` → `ledger/` → `lsm/` → other.
 *      Full-tree `walkSnapshotDirectory` remains for diagnostics.
 *
 * Layout constants are imported from `./snapshot.ts` so both the
 * Node FS reader and the browser walker share one source of truth.
 */
import {
  REQUIRED_LSM_ENTRIES,
  REQUIRED_TOP_LEVEL,
  SnapshotReadError,
} from "./snapshot.ts";

/** A file enumerated by the walker, paired with its OPFS-relative
 *  destination path. */
export interface SnapshotFile {
  readonly file: File;
  /** Slash-separated OPFS path under `/data/`. The lsm-worker's
   *  `LsmUploadChunk` writes to this exact path. */
  readonly opfsPath: string;
}

/** Root-relative prefix for ImmutableDB chunk files (optional in Mithril dumps). */
export const IMMUTABLE_DIR = "immutable" as const;

/** Upload priority for browser OPFS ingest (lower = earlier).
 *  Matches cardano-node bootstrap: seed `protocolMagicId` + ledger
 *  state + lsm session before optional ImmutableDB chunk files. */
export const snapshotUploadPriority = (opfsPath: string): number => {
  if (opfsPath === "protocolMagicId") return 0;
  if (opfsPath.startsWith("ledger/")) return 1;
  if (opfsPath.startsWith("lsm/")) return 2;
  if (opfsPath.startsWith(`${IMMUTABLE_DIR}/`)) return 4;
  return 3;
};

/** Sort snapshot files for chrome-ext upload (does not filter). */
export const sortSnapshotFilesForUpload = (
  files: ReadonlyArray<SnapshotFile>,
): ReadonlyArray<SnapshotFile> =>
  [...files].sort(
    (a, b) =>
      snapshotUploadPriority(a.opfsPath) - snapshotUploadPriority(b.opfsPath) ||
      a.opfsPath.localeCompare(b.opfsPath),
  );

const walkSnapshotDirectoryInto = async (
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: Array<SnapshotFile>,
  options?: { readonly skipRootDirs?: ReadonlySet<string> },
): Promise<void> => {
  for await (const [name, child] of dir.entries()) {
    if (prefix === "" && options?.skipRootDirs?.has(name)) continue;
    const next = prefix ? `${prefix}/${name}` : name;
    if (child.kind === "file") {
      out.push({ file: await child.getFile(), opfsPath: next });
    } else {
      await walkSnapshotDirectoryInto(child, next, out, options);
    }
  }
};

/** Count `.chunk` files directly under a snapshot `immutable/` dir (no `getFile`). */
const countImmutableChunks = async (
  immutableDir: FileSystemDirectoryHandle,
): Promise<number> => {
  let count = 0;
  for await (const [name, child] of immutableDir.entries()) {
    if (child.kind === "file" && name.endsWith(".chunk")) count++;
  }
  return count;
};

/** Recursively walk a `FileSystemDirectoryHandle` producing
 *  `(file, opfsPath)` tuples. Buffers into an array (deterministic
 *  order — root entries first, then recursive); callers iterate
 *  synchronously for upload. */
export const walkSnapshotDirectory = async (
  handle: FileSystemDirectoryHandle,
): Promise<ReadonlyArray<SnapshotFile>> => {
  const out: Array<SnapshotFile> = [];
  await walkSnapshotDirectoryInto(handle, "", out);
  return out;
};

export type BrowserSnapshotWalkResult = {
  readonly files: ReadonlyArray<SnapshotFile>;
  /** Count of `.chunk` files under `immutable/` when that subtree was skipped. */
  readonly skippedImmutableCount: number;
  /** Always 0 when `immutable/` is pruned without per-file `getFile` (fast path). */
  readonly skippedImmutableBytes: number;
};

/** Walk a snapshot for chrome-ext upload.
 *
 * Skips the immutable/ subtree by default (10k+ chunk files, often 10+ GiB).
 * Bootstraps from ledger state + lsm session, then relay ChainSync for blocks.
 *
 * Upload order: protocolMagicId, then ledger/, then lsm/, then other paths. */
export const walkSnapshotDirectoryForBrowserUpload = async (
  handle: FileSystemDirectoryHandle,
  options?: { readonly includeImmutable?: boolean },
): Promise<BrowserSnapshotWalkResult> => {
  const includeImmutable = options?.includeImmutable === true;
  let skippedImmutableCount = 0;
  let skippedImmutableBytes = 0;

  if (!includeImmutable) {
    try {
      const immutableDir = await handle.getDirectoryHandle(IMMUTABLE_DIR);
      skippedImmutableCount = await countImmutableChunks(immutableDir);
    } catch {
      // No immutable/ in this drop — fine for Mithril-minimal trees.
    }
  }

  const files: Array<SnapshotFile> = [];
  await walkSnapshotDirectoryInto(
    handle,
    "",
    files,
    includeImmutable ? undefined : { skipRootDirs: new Set([IMMUTABLE_DIR]) },
  );
  return {
    files: sortSnapshotFilesForUpload(files),
    skippedImmutableCount,
    skippedImmutableBytes,
  };
};

/** Validate that a dropped directory looks like a Mithril V2LSM
 *  snapshot before kicking off the upload. Checks for top-level
 *  entries (`protocolMagicId`, `ledger/`, `lsm/`) and the lsm-tree
 *  session-required entries under `lsm/` (`active/`, `metadata`,
 *  `snapshots/`).
 *
 *  Returns void on success; fails with `SnapshotReadError` on shape
 *  mismatch. The popup runs this BEFORE the upload so a wrong-drop
 *  surfaces a clear error in <100 ms instead of a 50 MiB wasted
 *  upload followed by a worker crash. */
export const validateSnapshotHandle = async (
  handle: FileSystemDirectoryHandle,
): Promise<void> => {
  const topLevel = new Set<string>();
  for await (const [name] of handle.entries()) topLevel.add(name);
  const missingTop = REQUIRED_TOP_LEVEL.filter((e) => !topLevel.has(e));
  if (missingTop.length > 0) {
    throw new SnapshotReadError({
      message: `Not a Mithril V2LSM snapshot — missing top-level entries: ${missingTop.join(", ")}`,
      cause: `present: ${[...topLevel].join(", ")}`,
    });
  }
  const lsmHandle = await handle.getDirectoryHandle("lsm");
  const lsmEntries = new Set<string>();
  for await (const [name] of lsmHandle.entries()) lsmEntries.add(name);
  const missingLsm = REQUIRED_LSM_ENTRIES.filter((e) => !lsmEntries.has(e));
  if (missingLsm.length > 0) {
    throw new SnapshotReadError({
      message: `lsm/ subdir is missing required entries: ${missingLsm.join(", ")}`,
      cause: `present: ${[...lsmEntries].join(", ")}`,
    });
  }
};
