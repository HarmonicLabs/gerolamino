/**
 * Bounded OPFS `lsm/` inspection for popup resume affordance + E2E diagnostics.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";

export type OpfsLsmInspect = {
  readonly hasSession: boolean;
  readonly hasSnapshots: boolean;
  readonly byteCount: number;
  readonly lastModifiedMs: number;
};

const maxInspectFiles = 512;

export const inspectOpfsLsm: Effect.Effect<
  OpfsLsmInspect,
  PlatformError,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const hasLsm = yield* fs.exists("lsm");
  if (!hasLsm) {
    return { hasSession: false, hasSnapshots: false, byteCount: 0, lastModifiedMs: 0 };
  }
  const hasSession = yield* fs.exists("lsm/active");
  const hasSnapshots = yield* fs.exists("lsm/snapshots");
  let byteCount = 0;
  let lastModifiedMs = 0;
  let filesVisited = 0;

  const walk = (dirPath: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(dirPath);
      for (const name of entries) {
        if (filesVisited >= maxInspectFiles) return;
        const child = dirPath === "" ? name : `${dirPath}/${name}`;
        const info = yield* fs.stat(child);
        if (info.type === "File") {
          filesVisited++;
          byteCount += Number(info.size);
          if (Option.isSome(info.mtime)) {
            const ms = info.mtime.value.getTime();
            if (ms > lastModifiedMs) lastModifiedMs = ms;
          }
        } else {
          yield* walk(child);
        }
      }
    });

  yield* walk("lsm");
  return { hasSession, hasSnapshots, byteCount, lastModifiedMs };
});
