// @ts-nocheck — `@bjorn3/browser_wasi_shim` typings omit WASI errno/constants used at runtime.
/**
 * WASI preopen tree backed by native OPFS (lazy sync handles for Haskell lsm-tree).
 *
 * Uses Effect `FileSystem` for layout (`ensureV2LsmLayout`); inode materialization
 * still requires native `FileSystemDirectoryHandle` for `@bjorn3/browser_wasi_shim`.
 */
import {
  Directory,
  type Fd,
  Inode,
  PreopenDirectory,
  SyncOPFSFile,
} from "@bjorn3/browser_wasi_shim";
import * as wasi from "@bjorn3/browser_wasi_shim";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { ensureV2LsmLayout } from "./file-system.ts";
import { opfsIoError } from "./internal.ts";

const parseRelativePath = (
  pathStr: string,
): { readonly ok: true; readonly parts: Array<string>; readonly isDir: boolean } | { readonly ok: false; readonly errno: number } => {
  if (pathStr.startsWith("/")) return { ok: false, errno: wasi.ERRNO_NOTCAPABLE };
  if (pathStr.includes("\x00")) return { ok: false, errno: wasi.ERRNO_INVAL };
  const parts: Array<string> = [];
  for (const component of pathStr.split("/")) {
    if (component === "" || component === ".") continue;
    if (component === "..") {
      if (parts.pop() === undefined) return { ok: false, errno: wasi.ERRNO_NOTCAPABLE };
      continue;
    }
    parts.push(component);
  }
  return { ok: true, parts, isDir: pathStr.endsWith("/") };
};

/** Bridge async OPFS into sync WASI ops (dedicated worker only). */
export const runOpfsSync = <A>(op: () => Promise<A>): A => {
  let state = 0;
  let result!: A;
  let error: unknown;
  void op().then(
    (value) => {
      result = value;
      state = 1;
    },
    (cause) => {
      error = cause;
      state = 2;
    },
  );
  const lock = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 60_000;
  while (state === 0 && Date.now() < deadline) {
    Atomics.wait(lock, 0, 0, 4);
  }
  if (state === 0) {
    throw new Error("OPFS sync operation timed out after 60s");
  }
  if (state === 2) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  return result;
};

const openSyncHandle = (
  dir: FileSystemDirectoryHandle,
  name: string,
  create: boolean,
  readonly: boolean,
): FileSystemSyncAccessHandle =>
  runOpfsSync(async () => {
    const file = await dir.getFileHandle(name, { create });
    return file.createSyncAccessHandle();
  });

export class LazySyncOPFSFile extends Inode {
  constructor(
    private readonly nativeDir: FileSystemDirectoryHandle,
    private readonly fileName: string,
    private readonly readonlyDefault: boolean,
  ) {
    super();
  }

  stat(): wasi.Filestat {
    const size = runOpfsSync(async () => {
      const file = await this.nativeDir.getFileHandle(this.fileName, { create: false });
      return (await file.getFile()).size;
    });
    return new wasi.Filestat(this.ino, wasi.FILETYPE_REGULAR_FILE, BigInt(size));
  }

  path_open(
    oflags: number,
    fs_rights_base: bigint,
    fd_flags: number,
  ): { ret: number; fd_obj: Fd | null } {
    const readonly =
      this.readonlyDefault ||
      (fs_rights_base & BigInt(wasi.RIGHTS_FD_WRITE)) !== BigInt(wasi.RIGHTS_FD_WRITE);
    try {
      const create = (oflags & wasi.OFLAGS_CREAT) === wasi.OFLAGS_CREAT;
      const handle = openSyncHandle(this.nativeDir, this.fileName, create, readonly);
      const backing = new SyncOPFSFile(handle, { readonly });
      return backing.path_open(oflags, fs_rights_base, fd_flags);
    } catch {
      return { ret: wasi.ERRNO_IO, fd_obj: null };
    }
  }
}

export class OpfsBackedDirectory extends Directory {
  constructor(
    readonly nativeHandle: FileSystemDirectoryHandle,
    contents: Map<string, Inode>,
  ) {
    super(contents);
  }

  create_entry_for_path(
    pathStr: string,
    isDir: boolean,
  ): { ret: number; entry: Inode | null } {
    const parsed = parseRelativePath(pathStr);
    if (!parsed.ok) return { ret: parsed.errno, entry: null };

    const filename = parsed.parts.pop();
    if (filename === undefined) return { ret: wasi.ERRNO_INVAL, entry: null };

    let parentDir: OpfsBackedDirectory = this;
    for (const component of parsed.parts) {
      const child = parentDir.contents.get(component);
      if (!(child instanceof OpfsBackedDirectory)) {
        return { ret: wasi.ERRNO_NOTDIR, entry: null };
      }
      parentDir = child;
    }

    const opfsParent = parentDir.nativeHandle;

    if (parentDir.contents.has(filename)) {
      return { ret: wasi.ERRNO_EXIST, entry: null };
    }

    try {
      let entry: Inode;
      if (isDir) {
        const nativeChild = runOpfsSync(() =>
          opfsParent.getDirectoryHandle(filename, { create: true }),
        );
        entry = new OpfsBackedDirectory(nativeChild, new Map());
      } else {
        runOpfsSync(() => opfsParent.getFileHandle(filename, { create: true }));
        entry = new LazySyncOPFSFile(opfsParent, filename, false);
      }
      parentDir.contents.set(filename, entry);
      if (entry instanceof Directory) {
        entry.parent = parentDir;
      }
      return { ret: wasi.ERRNO_SUCCESS, entry };
    } catch {
      return { ret: wasi.ERRNO_IO, entry: null };
    }
  }
}

const buildDir = async (
  handle: FileSystemDirectoryHandle,
  maxFiles: number,
  counter: { n: number },
): Promise<OpfsBackedDirectory> => {
  const entries = new Map<string, Inode>();
  for await (const [name, child] of handle.entries()) {
    if (child.kind === "directory") {
      entries.set(name, await buildDir(child, maxFiles, counter));
    } else if (counter.n < maxFiles) {
      entries.set(name, new LazySyncOPFSFile(handle, name, false));
      counter.n++;
    }
  }
  return new OpfsBackedDirectory(handle, entries);
};

const buildFromNativeRoot = async (
  sessionMount: string,
  lsmSubdir: string,
  maxFiles: number,
): Promise<{ preopen: PreopenDirectory; filesMounted: number }> => {
  const root = await navigator.storage.getDirectory();
  const counter = { n: 0 };
  let lsmDir: OpfsBackedDirectory;
  try {
    const lsmHandle = await root.getDirectoryHandle(lsmSubdir, { create: false });
    lsmDir = await buildDir(lsmHandle, maxFiles, counter);
  } catch {
    const nativeLsm = await root.getDirectoryHandle(lsmSubdir, { create: true });
    await nativeLsm.getDirectoryHandle("active", { create: true });
    await nativeLsm.getDirectoryHandle("snapshots", { create: true });
    const meta = await nativeLsm.getFileHandle("metadata", { create: true });
    const access = await meta.createSyncAccessHandle();
    try {
      const bytes = new TextEncoder().encode("v2");
      access.write(bytes, { at: 0 });
      access.truncate(bytes.length);
      access.flush();
    } finally {
      access.close();
    }
    lsmDir = await buildDir(nativeLsm, maxFiles, counter);
  }
  const entries = new Map<string, Inode>();
  entries.set(lsmSubdir, lsmDir);
  return { preopen: new PreopenDirectory(sessionMount, entries), filesMounted: counter.n };
};

/**
 * Build `/data` preopen with `lsm/` backed by native OPFS. Ensures V2 layout via
 * `FileSystem` before walking native handles.
 */
export const buildWasiPreopen = (
  sessionMount: string,
  lsmSubdir: string,
  maxFiles: number,
): Effect.Effect<
  { readonly preopen: PreopenDirectory; readonly filesMounted: number },
  PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    yield* ensureV2LsmLayout;
    return yield* Effect.tryPromise({
      try: () => buildFromNativeRoot(sessionMount, lsmSubdir, maxFiles),
      catch: (cause) => opfsIoError("buildWasiPreopen", lsmSubdir, cause),
    });
  });

/** @deprecated Use `buildWasiPreopen` with `OpfsFileSystem.layer` provided. */
export const buildOpfsPreopenFromNative = (
  sessionMount: string,
  lsmSubdir: string,
  maxFiles: number,
): Promise<{ preopen: PreopenDirectory; filesMounted: number }> =>
  buildFromNativeRoot(sessionMount, lsmSubdir, maxFiles);
