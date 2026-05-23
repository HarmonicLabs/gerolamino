/**
 * OPFS-backed `FileSystem` layer for browser extension + dedicated worker contexts.
 *
 * Effect's `FileSystem` is the abstract service (`effect/FileSystem`); this module
 * is the chrome-ext concrete implementation (analogous to `BunFileSystem` /
 * `NodeFileSystem` on Node). Provide `OpfsFileSystem.layer` at entrypoints and
 * `yield* FileSystem.FileSystem` in application code — never call
 * `navigator.storage.getDirectory()` directly outside this module or `wasi-preopen.ts`.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { REQUIRED_LSM_ENTRIES } from "bootstrap";
import {
  isOpfsWorkerContext,
  normalizeOpfsPath,
  opfsIoError,
  opfsNotFound,
  opfsNotSupported,
  resolveOpfsDirectory,
  resolveOpfsFile,
  splitOpfsPath,
} from "./internal.ts";

const defaultMode = 0o644;

const statFromFile = (file: File): FileSystem.File.Info => ({
  type: "File",
  mtime: Option.some(new Date(file.lastModified)),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: defaultMode,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(BigInt(file.size)),
  blksize: Option.none(),
  blocks: Option.none(),
});

const statDirectory: FileSystem.File.Info = {
  type: "Directory",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: defaultMode,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0n),
  blksize: Option.none(),
  blocks: Option.none(),
};

const getOpfsRoot = (): Effect.Effect<FileSystemDirectoryHandle, PlatformError> =>
  Effect.tryPromise({
    try: () => navigator.storage.getDirectory(),
    catch: (cause) => opfsIoError("getOpfsRoot", "", cause),
  });

const pathExists = (
  root: FileSystemDirectoryHandle,
  path: string,
): Effect.Effect<boolean, PlatformError> =>
  Effect.tryPromise({
    try: async () => {
      const normalized = normalizeOpfsPath(path);
      if (normalized.length === 0) return true;
      const segments = [...splitOpfsPath(normalized)];
      const name = segments.pop();
      if (name === undefined) {
        await resolveOpfsDirectory(root, segments, false);
        return true;
      }
      const parent = await resolveOpfsDirectory(root, segments, false);
      try {
        await parent.getFileHandle(name, { create: false });
        return true;
      } catch {
        try {
          await parent.getDirectoryHandle(name, { create: false });
          return true;
        } catch {
          return false;
        }
      }
    },
    catch: (cause) => opfsIoError("exists", path, cause),
  });

const makeOpfsFileSystem = (root: FileSystemDirectoryHandle): FileSystem.FileSystem => {
  let nextFd = 1;

  class OpfsFileHandle implements FileSystem.File {
    readonly [FileSystem.FileTypeId] = FileSystem.FileTypeId;
    readonly fd: FileSystem.File.Descriptor;
    private position = 0n;
    private readonly syncHandle: FileSystemSyncAccessHandle | undefined;
    private readonly blob: Uint8Array | undefined;

    constructor(
      fd: FileSystem.File.Descriptor,
      syncHandle: FileSystemSyncAccessHandle | undefined,
      blob: Uint8Array | undefined,
    ) {
      this.fd = fd;
      this.syncHandle = syncHandle;
      this.blob = blob;
    }

    get stat(): Effect.Effect<FileSystem.File.Info, PlatformError> {
      if (this.syncHandle !== undefined) {
        return Effect.sync(() => ({
          ...statFromFile({ size: this.syncHandle!.getSize(), lastModified: Date.now() } as File),
          size: FileSystem.Size(BigInt(this.syncHandle!.getSize())),
        }));
      }
      return Effect.succeed({
        ...statFromFile({ size: this.blob?.length ?? 0, lastModified: Date.now() } as File),
        size: FileSystem.Size(BigInt(this.blob?.length ?? 0)),
      });
    }

    get sync(): Effect.Effect<void, PlatformError> {
      const handle = this.syncHandle;
      if (handle === undefined) return Effect.void;
      return Effect.try({
        try: () => {
          handle.flush();
        },
        catch: (cause) => opfsIoError("sync", String(this.fd), cause),
      });
    }

    seek(offset: FileSystem.SizeInput, from: FileSystem.SeekMode): Effect.Effect<void> {
      const off = FileSystem.Size(offset);
      return Effect.sync(() => {
        if (from === "start") {
          this.position = off;
        } else {
          this.position = this.position + off;
        }
      });
    }

    read(buffer: Uint8Array): Effect.Effect<FileSystem.Size, PlatformError> {
      const self = this;
      return Effect.gen(function* () {
        const chunk = yield* self.readAlloc(FileSystem.Size(buffer.length));
        if (Option.isNone(chunk)) return FileSystem.Size(0n);
        const bytes = chunk.value;
        const n = Math.min(bytes.length, buffer.length);
        buffer.set(bytes.subarray(0, n));
        return FileSystem.Size(BigInt(n));
      });
    }

    readAlloc(size: FileSystem.SizeInput): Effect.Effect<Option.Option<Uint8Array>, PlatformError> {
      const want = Number(FileSystem.Size(size));
      return Effect.try({
        try: () => {
          if (this.syncHandle !== undefined) {
            const buf = new Uint8Array(want);
            const read = this.syncHandle.read(buf, { at: Number(this.position) });
            if (read === 0) return Option.none();
            this.position += BigInt(read);
            return Option.some(buf.subarray(0, read));
          }
          if (this.blob === undefined) return Option.none();
          const start = Number(this.position);
          const slice = this.blob.subarray(start, start + want);
          if (slice.length === 0) return Option.none();
          this.position += BigInt(slice.length);
          return Option.some(slice);
        },
        catch: (cause) => opfsIoError("readAlloc", String(this.fd), cause),
      });
    }

    truncate(length?: FileSystem.SizeInput): Effect.Effect<void, PlatformError> {
      if (this.syncHandle === undefined) return Effect.fail(opfsNotSupported("truncate"));
      const len = length !== undefined ? Number(FileSystem.Size(length)) : 0;
      return Effect.try({
        try: () => {
          this.syncHandle!.truncate(len);
          if (this.position > BigInt(len)) this.position = BigInt(len);
        },
        catch: (cause) => opfsIoError("truncate", String(this.fd), cause),
      });
    }

    write(buffer: Uint8Array): Effect.Effect<FileSystem.Size, PlatformError> {
      if (this.syncHandle !== undefined) {
        return Effect.try({
          try: () => {
            const written = this.syncHandle!.write(buffer, { at: Number(this.position) });
            this.position += BigInt(written);
            return FileSystem.Size(BigInt(written));
          },
          catch: (cause) => opfsIoError("write", String(this.fd), cause),
        });
      }
      return Effect.fail(opfsNotSupported("write"));
    }

    writeAll(buffer: Uint8Array): Effect.Effect<void, PlatformError> {
      const self = this;
      return Effect.gen(function* () {
        let offset = 0;
        while (offset < buffer.length) {
          const n = Number(yield* self.write(buffer.subarray(offset)));
          if (n === 0) {
            return yield* Effect.fail(
              opfsIoError("writeAll", String(self.fd), new Error("write returned 0 bytes")),
            );
          }
          offset += n;
        }
      });
    }

    close(): void {
      if (this.syncHandle !== undefined) {
        try {
          this.syncHandle.close();
        } catch {
          /* best-effort */
        }
      }
    }
  }

  const readFileOp = (path: string) =>
    Effect.tryPromise({
      try: async () => {
        const { parent, name } = await resolveOpfsFile(root, path, false);
        const file = await parent.getFileHandle(name, { create: false });
        const blob = await file.getFile();
        return new Uint8Array(await blob.arrayBuffer());
      },
      catch: (cause) => opfsIoError("readFile", path, cause),
    });

  const writeFileOp = (path: string, data: Uint8Array) =>
    Effect.tryPromise({
      try: async () => {
        const { parent, name } = await resolveOpfsFile(root, path, true);
        if (isOpfsWorkerContext()) {
          const file = await parent.getFileHandle(name, { create: true });
          const handle = await file.createSyncAccessHandle();
          try {
            handle.truncate(0);
            handle.write(data, { at: 0 });
            handle.flush();
          } finally {
            handle.close();
          }
          return;
        }
        const file = await parent.getFileHandle(name, { create: true });
        const writable = await file.createWritable();
        await writable.write(new Uint8Array(data));
        await writable.close();
      },
      catch: (cause) => opfsIoError("writeFile", path, cause),
    });

  const statOp = (path: string) =>
    Effect.tryPromise({
      try: async () => {
        const normalized = normalizeOpfsPath(path);
        if (normalized.length === 0) return statDirectory;
        const segments = [...splitOpfsPath(normalized)];
        const name = segments.pop();
        if (name === undefined) {
          await resolveOpfsDirectory(root, segments, false);
          return statDirectory;
        }
        const parent = await resolveOpfsDirectory(root, segments, false);
        try {
          const file = await parent.getFileHandle(name, { create: false });
          return statFromFile(await file.getFile());
        } catch {
          await parent.getDirectoryHandle(name, { create: false });
          return statDirectory;
        }
      },
      catch: (cause) => opfsIoError("stat", path, cause),
    });

  return FileSystem.make({
    access: (path) =>
      pathExists(root, path).pipe(
        Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(opfsNotFound("access", path)))),
      ),

    chmod: () => Effect.fail(opfsNotSupported("chmod")),
    chown: () => Effect.fail(opfsNotSupported("chown")),
    link: () => Effect.fail(opfsNotSupported("link")),
    symlink: () => Effect.fail(opfsNotSupported("symlink")),
    readLink: () => Effect.fail(opfsNotSupported("readLink")),
    realPath: (path) => Effect.succeed(normalizeOpfsPath(path)),
    rename: () => Effect.fail(opfsNotSupported("rename")),
    truncate: () => Effect.fail(opfsNotSupported("truncate")),
    utimes: () => Effect.fail(opfsNotSupported("utimes")),
    makeTempDirectory: () => Effect.fail(opfsNotSupported("makeTempDirectory")),
    makeTempDirectoryScoped: () => Effect.fail(opfsNotSupported("makeTempDirectoryScoped")),
    makeTempFile: () => Effect.fail(opfsNotSupported("makeTempFile")),
    makeTempFileScoped: () => Effect.fail(opfsNotSupported("makeTempFileScoped")),

    makeDirectory: (path, options) =>
      Effect.tryPromise({
        try: async () => {
          const segments = splitOpfsPath(path);
          await resolveOpfsDirectory(root, segments, options?.recursive ?? false);
        },
        catch: (cause) => opfsIoError("makeDirectory", path, cause),
      }),

    remove: (path, options) =>
      Effect.tryPromise({
        try: async () => {
          const normalized = normalizeOpfsPath(path);
          if (normalized.length === 0) {
            for await (const [name] of root.entries()) {
              await root.removeEntry(name, { recursive: true });
            }
            return;
          }
          const segments = [...splitOpfsPath(normalized)];
          const name = segments.pop();
          if (name === undefined) return;
          const parent = await resolveOpfsDirectory(root, segments, false);
          await parent.removeEntry(name, { recursive: options?.recursive ?? false });
        },
        catch: (cause) => opfsIoError("remove", path, cause),
      }).pipe(
        Effect.catchIf(
          (e) => options?.force === true && e.reason._tag === "NotFound",
          () => Effect.void,
        ),
      ),

    readDirectory: (path, options) =>
      Effect.tryPromise({
        try: async () => {
          const dir =
            normalizeOpfsPath(path).length === 0
              ? root
              : await resolveOpfsDirectory(root, splitOpfsPath(path), false);
          if (options?.recursive === true) {
            const out: Array<string> = [];
            const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
              for await (const [name, child] of handle.entries()) {
                const rel = prefix === "" ? name : `${prefix}/${name}`;
                out.push(rel);
                if (child.kind === "directory") await walk(child, rel);
              }
            };
            await walk(dir, "");
            return out;
          }
          const names: Array<string> = [];
          for await (const [name] of dir.entries()) names.push(name);
          return names;
        },
        catch: (cause) => opfsIoError("readDirectory", path, cause),
      }),

    readFile: readFileOp,

    writeFile: writeFileOp,

    stat: statOp,

    copy: (fromPath, toPath, options) =>
      Effect.gen(function* () {
        const info = yield* statOp(fromPath);
        if (info.type === "Directory") {
          return yield* Effect.fail(opfsNotSupported("copy-directory"));
        }
        const bytes = yield* readFileOp(fromPath);
        const exists = yield* pathExists(root, toPath);
        if (exists && options?.overwrite !== true) {
          return yield* Effect.fail(opfsIoError("copy", toPath, new Error("destination exists")));
        }
        yield* writeFileOp(toPath, bytes);
      }),

    copyFile: (fromPath, toPath) =>
      Effect.gen(function* () {
        const bytes = yield* readFileOp(fromPath);
        yield* writeFileOp(toPath, bytes);
      }),

    open: (path, options) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const { parent, name } = await resolveOpfsFile(root, path, true);
            const flag = options?.flag ?? "r";
            const fd = FileSystem.FileDescriptor(nextFd++);
            if (isOpfsWorkerContext() && (flag.includes("w") || flag.includes("+") || flag === "a")) {
              const file = await parent.getFileHandle(name, { create: true });
              const handle = await file.createSyncAccessHandle();
              if (flag === "w" || flag === "w+") {
                handle.truncate(0);
              }
              return new OpfsFileHandle(fd, handle, undefined);
            }
            const file = await parent.getFileHandle(name, { create: flag.includes("w") || flag.includes("a") });
            const blob = new Uint8Array(await (await file.getFile()).arrayBuffer());
            return new OpfsFileHandle(fd, undefined, blob);
          },
          catch: (cause) => opfsIoError("open", path, cause),
        }),
        (file) => Effect.sync(() => file.close()),
      ),

    watch: () => Stream.fail(opfsNotSupported("watch")),
  });
};

/**
 * Provides `FileSystem` backed by the origin-private OPFS root
 * (`navigator.storage.getDirectory()`).
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<FileSystem.FileSystem> = Layer.effect(FileSystem.FileSystem)(
  Effect.orDie(Effect.map(getOpfsRoot(), makeOpfsFileSystem)),
);

/** Wipe the OPFS root (hermetic E2E / genesis runs). */
export const clearOpfsRoot: Effect.Effect<void, PlatformError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove("", { recursive: true, force: true });
  });

/** Ensure empty genesis V2LSM layout under `lsm/`. */
export const ensureV2LsmLayout: Effect.Effect<void, PlatformError, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory("lsm/active", { recursive: true });
    yield* fs.makeDirectory("lsm/snapshots", { recursive: true });
    const hasMeta = yield* fs.exists("lsm/metadata");
    if (!hasMeta) {
      yield* fs.writeFileString("lsm/metadata", "v2");
    }
    for (const entry of REQUIRED_LSM_ENTRIES) {
      if (entry === "metadata") continue;
      yield* fs.makeDirectory(`lsm/${entry}`, { recursive: true });
    }
  });

/** Write a snapshot upload chunk at `offset` (no queues — direct OPFS via `open`/`seek`/`write`). */
export const writeOpfsFileSlice = (
  path: string,
  offset: number,
  data: Uint8Array,
  final: boolean,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const normalized = normalizeOpfsPath(path);
    if (offset === 0 && final) {
      yield* fs.writeFile(normalized, data);
      return;
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(normalized, { flag: "r+" });
        yield* file.seek(FileSystem.Size(offset), "start");
        yield* file.write(data);
        if (final) {
          yield* file.truncate(FileSystem.Size(offset + BigInt(data.length)));
          yield* file.sync;
        }
      }),
    );
  });
