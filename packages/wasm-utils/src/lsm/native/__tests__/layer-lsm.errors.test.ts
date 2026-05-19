/**
 * Error-path tests for `layerLsm` / `layerLsmFromSnapshot` / `admin.openSnapshot`.
 *
 * Each test asserts the layer produces a typed error (`LsmBridgeError` or
 * `LsmAdminError`) rather than silently leaving the Zig bridge in a
 * half-initialized state — regression guard for the silent-init-failure
 * bug where a non-zero `lsm_bridge_init` return code used to be discarded.
 *
 * These tests run against a live `liblsm-bridge.so`; they are skipped when
 * `LIBLSM_BRIDGE_PATH` is unset.
 */
import { describe, it, expect } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { BlobStore } from "../../blob-store.ts";
import { LsmAdmin, LsmAdminError } from "../admin";
import { LsmBridgeError } from "../ffi";
import { layerLsm, layerLsmFromSnapshot } from "../layer-lsm";

const LIBLSM_BRIDGE_PATH = process.env["LIBLSM_BRIDGE_PATH"];
const skip = !LIBLSM_BRIDGE_PATH;

const TestPlatformLayer = Layer.mergeAll(BunFileSystem.layer, Path.layer);

const isLsmBridgeError = Schema.is(LsmBridgeError);
const isLsmAdminError = Schema.is(LsmAdminError);

/** A path with a missing parent directory — used to provoke init failure. */
const NONEXISTENT_PARENT = "/tmp/lsm-err-no-parent-xyz-abc123/child";

const acquireSessionDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "lsm-err-" }),
);

/** Extract the first typed error from an Exit, or undefined if not a failure. */
const firstError = <E, A>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe.skipIf(skip)("LSM layer error paths", () => {
  it.effect("layerLsm fails with LsmBridgeError when parent directory is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.gen(function* () {
        yield* BlobStore;
      }).pipe(Effect.provide(layerLsm(NONEXISTENT_PARENT)), Effect.exit);

      const err = firstError(exit);
      expect(isLsmBridgeError(err)).toBe(true);
      if (isLsmBridgeError(err)) {
        expect(err.operation).toBe("init");
      }
    }),
  );

  it.effect("layerLsmFromSnapshot fails with LsmBridgeError when session dir is missing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.gen(function* () {
        yield* BlobStore;
      }).pipe(
        Effect.provide(layerLsmFromSnapshot(NONEXISTENT_PARENT, "no-such-snap", "UTxO table")),
        Effect.exit,
      );

      const err = firstError(exit);
      expect(isLsmBridgeError(err)).toBe(true);
      if (isLsmBridgeError(err)) {
        expect(err.operation).toBe("init_from_snapshot");
      }
    }),
  );

  it.effect(
    "layerLsmFromSnapshot fails with LsmBridgeError when snapshot name does not exist",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessionDir = yield* acquireSessionDir;
          const exit = yield* Effect.gen(function* () {
            yield* BlobStore;
          }).pipe(
            Effect.provide(
              layerLsmFromSnapshot(sessionDir, "snapshot-that-never-existed", "UTxO table"),
            ),
            Effect.exit,
          );

          const err = firstError(exit);
          expect(isLsmBridgeError(err)).toBe(true);
          if (isLsmBridgeError(err)) {
            expect(err.operation).toBe("init_from_snapshot");
          }
        }),
      ).pipe(Effect.provide(TestPlatformLayer)),
  );

  it.effect("admin.openSnapshot fails with LsmAdminError when snapshot name does not exist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessionDir = yield* acquireSessionDir;
        const exit = yield* Effect.gen(function* () {
          const admin = yield* LsmAdmin;
          yield* admin.openSnapshot("snapshot-that-never-existed", "UTxO table");
        }).pipe(Effect.provide(layerLsm(sessionDir)), Effect.exit);

        const err = firstError(exit);
        expect(isLsmAdminError(err)).toBe(true);
        if (isLsmAdminError(err)) {
          expect(err.operation).toBe("openSnapshot");
        }
      }),
    ).pipe(Effect.provide(TestPlatformLayer)),
  );

  it.effect(
    "admin.openSnapshot fails with LsmAdminError when label does not match saved snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessionDir = yield* acquireSessionDir;
          const exit = yield* Effect.gen(function* () {
            const store = yield* BlobStore;
            const admin = yield* LsmAdmin;
            yield* store.put(new Uint8Array([1]), new Uint8Array([2]));
            yield* admin.snapshot("label-mismatch-snap", "correct-label");
            yield* admin.openSnapshot("label-mismatch-snap", "wrong-label");
          }).pipe(Effect.provide(layerLsm(sessionDir)), Effect.exit);

          const err = firstError(exit);
          expect(isLsmAdminError(err)).toBe(true);
          if (isLsmAdminError(err)) {
            expect(err.operation).toBe("openSnapshot");
          }
        }),
      ).pipe(Effect.provide(TestPlatformLayer)),
  );
});
