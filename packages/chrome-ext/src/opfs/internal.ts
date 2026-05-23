/**
 * Shared OPFS path helpers and native handle resolution.
 */
import { badArgument, systemError, type PlatformError } from "effect/PlatformError";

export const OPFS_MODULE = "OpfsFileSystem";

/** Normalize a logical path relative to the OPFS root. */
export const normalizeOpfsPath = (path: string): string => {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.includes("..")) {
    throw badArgument({
      module: OPFS_MODULE,
      method: "normalizeOpfsPath",
      description: "path must not contain ..",
    });
  }
  return trimmed;
};

export const splitOpfsPath = (path: string): ReadonlyArray<string> => {
  const normalized = normalizeOpfsPath(path);
  if (normalized.length === 0) return [];
  return normalized.split("/").filter((s) => s.length > 0);
};

export const opfsNotFound = (method: string, path: string): PlatformError =>
  systemError({
    _tag: "NotFound",
    module: OPFS_MODULE,
    method,
    description: "No such file or directory",
    pathOrDescriptor: path,
  });

export const opfsIoError = (
  method: string,
  path: string,
  cause: unknown,
): PlatformError =>
  systemError({
    _tag: "Unknown",
    module: OPFS_MODULE,
    method,
    description: cause instanceof Error ? cause.message : String(cause),
    pathOrDescriptor: path,
    cause,
  });

export const opfsNotSupported = (method: string): PlatformError =>
  badArgument({
    module: OPFS_MODULE,
    method,
    description: "not supported on OPFS",
  });

export type OpfsResolvedFile = {
  readonly parent: FileSystemDirectoryHandle;
  readonly name: string;
};

/** Walk `segments` under `root`, optionally creating missing directories. */
export const resolveOpfsDirectory = async (
  root: FileSystemDirectoryHandle,
  segments: ReadonlyArray<string>,
  create: boolean,
): Promise<FileSystemDirectoryHandle> => {
  let dir = root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
};

export const resolveOpfsFile = async (
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<OpfsResolvedFile> => {
  const segments = [...splitOpfsPath(path)];
  const filename = segments.pop();
  if (filename === undefined) {
    throw badArgument({
      module: OPFS_MODULE,
      method: "resolveOpfsFile",
      description: "path must name a file",
    });
  }
  const parent = await resolveOpfsDirectory(root, segments, create);
  return { parent, name: filename };
};

/** Dedicated worker (has `importScripts`; offscreen document does not). */
export const isOpfsWorkerContext = (): boolean => typeof importScripts === "function";
