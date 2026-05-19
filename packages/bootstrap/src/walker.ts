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
 *   2. **Walk** — yields `{ file, opfsPath }` pairs in upload order.
 *      Files under `lsm/` are mapped to `lsm/...` under OPFS so the
 *      lsm-worker's session opens against the same tree the user
 *      dropped. Out-of-`lsm/` files (`protocolMagicId`,
 *      `ledger/{slot}/state`, `immutable/*.chunk`) are surfaced too —
 *      the worker doesn't open the lsm-tree against them today, but
 *      the consensus layer's future "seed LedgerView from disk" path
 *      will read them via the same OPFS tree.
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

/** Recursively walk a `FileSystemDirectoryHandle` producing
 *  `(file, opfsPath)` tuples. Buffers into an array (deterministic
 *  order — root entries first, then recursive); callers iterate
 *  synchronously for upload. */
export const walkSnapshotDirectory = async (
  handle: FileSystemDirectoryHandle,
): Promise<ReadonlyArray<SnapshotFile>> => {
  const out: Array<SnapshotFile> = [];
  const walk = async (
    dir: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<void> => {
    for await (const [name, child] of dir.entries()) {
      const next = prefix ? `${prefix}/${name}` : name;
      if (child.kind === "file") {
        out.push({ file: await child.getFile(), opfsPath: next });
      } else {
        await walk(child, next);
      }
    }
  };
  await walk(handle, "");
  return out;
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
