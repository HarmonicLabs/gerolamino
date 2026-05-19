/**
 * Test-coverage gap (no test file at all) — `bootstrap/src/snapshot.ts`.
 *
 * `readSnapshotMeta` and `findLatestLsmSnapshot` are pure
 * `FileSystem`-driven Effect programs. `Effect.FileSystem.layerNoop`
 * accepts a `Partial<FileSystem>` so we can fake `readDirectory` +
 * `readFile` for each scenario without disk I/O.
 *
 * The functions encode multiple shape conventions found in the wild:
 *  - `ledger/<slot>` (native cardano-node V2LSM dump)
 *  - `ledger/<slot>_lsm` (Mithril snapshot-converter --utxo-hd-flavor LSM)
 *  - `ledger/<slot>` AND `ledger/<slot>_lsm` (snapshot-converter sibling)
 *
 * Without these tests, a regex tweak in the slot-discovery code
 * (`SLOT_DIR = /^(\d+)(?:_lsm)?$/` at snapshot.ts:56) could silently
 * pick the wrong directory.
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, FileSystem, Path, Layer } from "effect";
import { systemError } from "effect/PlatformError";
import {
  findLatestLsmSnapshot,
  readSnapshotMeta,
  SnapshotReadError,
} from "../snapshot.ts";

const NOT_FOUND = (path: string) =>
  systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "test-fixture",
    pathOrDescriptor: path,
  });

const fakeFsLayer = (
  files: Record<string, Uint8Array>,
  directories: Record<string, ReadonlyArray<string>>,
) =>
  FileSystem.layerNoop({
    readFile: (path: string) => {
      const hit = files[path];
      if (hit) return Effect.succeed(hit);
      return Effect.fail(NOT_FOUND(path));
    },
    readDirectory: (path: string) => {
      const hit = directories[path];
      if (hit) return Effect.succeed([...hit]);
      return Effect.fail(NOT_FOUND(path));
    },
  });

const layers = (
  files: Record<string, Uint8Array>,
  directories: Record<string, ReadonlyArray<string>>,
) => Layer.merge(fakeFsLayer(files, directories), Path.layer);

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("readSnapshotMeta", () => {
  it.effect("decodes a Mithril V2LSM snapshot with `<slot>_lsm` shape", () =>
    Effect.gen(function* () {
      const meta = yield* readSnapshotMeta("/snap");
      expect(meta.snapshotSlot).toBe(78123456n);
      expect(meta.protocolMagic).toBe(1);
      expect(meta.ledgerDir).toBe("/snap/ledger/78123456_lsm");
      expect(meta.immutableDir).toBe("/snap/immutable");
      expect(meta.lsmDir).toBe("/snap/lsm");
      expect(meta.totalChunks).toBe(2);
    }).pipe(
      Effect.provide(
        layers(
          { "/snap/protocolMagicId": enc("1") },
          {
            "/snap/ledger": ["78123456_lsm"],
            "/snap/immutable": ["00000.chunk", "00001.chunk", "secondary.lock"],
          },
        ),
      ),
    ),
  );

  it.effect("prefers plain-digit `<slot>` over sibling `<slot>_lsm` when both exist", () =>
    Effect.gen(function* () {
      const meta = yield* readSnapshotMeta("/snap");
      // Per snapshot.ts:60-62: plain-digit (no `_lsm` suffix) wins.
      expect(meta.ledgerDir).toBe("/snap/ledger/78123456");
    }).pipe(
      Effect.provide(
        layers(
          { "/snap/protocolMagicId": enc("764824073") },
          {
            "/snap/ledger": ["78123456", "78123456_lsm"],
            "/snap/immutable": [],
          },
        ),
      ),
    ),
  );

  it.effect("ignores non-numeric entries in ledger/", () =>
    Effect.gen(function* () {
      const meta = yield* readSnapshotMeta("/snap");
      expect(meta.snapshotSlot).toBe(50n);
      // .DS_Store and similar junk must not crash the regex match.
    }).pipe(
      Effect.provide(
        layers(
          { "/snap/protocolMagicId": enc("1") },
          {
            "/snap/ledger": [".DS_Store", "README.md", "50"],
            "/snap/immutable": [],
          },
        ),
      ),
    ),
  );

  it.effect("fails with SnapshotReadError when ledger/ has no slot directory", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(readSnapshotMeta("/snap"));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        // Cause should contain the SnapshotReadError tag.
        const causeStr = String(result.cause);
        expect(causeStr).toContain("SnapshotReadError");
      }
    }).pipe(
      Effect.provide(
        layers(
          { "/snap/protocolMagicId": enc("1") },
          {
            "/snap/ledger": ["not-a-slot", "README"],
            "/snap/immutable": [],
          },
        ),
      ),
    ),
  );

  it.effect("counts only .chunk files as totalChunks", () =>
    Effect.gen(function* () {
      const meta = yield* readSnapshotMeta("/snap");
      // 3 .chunk files; the 2 .lock + .primary entries don't count.
      expect(meta.totalChunks).toBe(3);
    }).pipe(
      Effect.provide(
        layers(
          { "/snap/protocolMagicId": enc("1") },
          {
            "/snap/ledger": ["100"],
            "/snap/immutable": [
              "00000.chunk",
              "00001.chunk",
              "00002.chunk",
              "secondary.lock",
              "secondary.primary",
            ],
          },
        ),
      ),
    ),
  );
});

describe("findLatestLsmSnapshot", () => {
  it.effect("returns the highest-numbered slot directory", () =>
    Effect.gen(function* () {
      const name = yield* findLatestLsmSnapshot("/db/lsm");
      expect(name).toBe("100");
    }).pipe(
      Effect.provide(
        layers({}, { "/db/lsm/snapshots": ["10", "100", "50"] }),
      ),
    ),
  );

  it.effect("uses BigInt comparison so 100 > 50 (not lexicographic)", () =>
    Effect.gen(function* () {
      // Lex: "9" > "100"; numeric: 100 > 9.
      const name = yield* findLatestLsmSnapshot("/db/lsm");
      expect(name).toBe("100");
    }).pipe(
      Effect.provide(
        layers({}, { "/db/lsm/snapshots": ["9", "100"] }),
      ),
    ),
  );

  it.effect("ignores non-numeric directory names", () =>
    Effect.gen(function* () {
      const name = yield* findLatestLsmSnapshot("/db/lsm");
      // .lock + .DS_Store don't count.
      expect(name).toBe("42");
    }).pipe(
      Effect.provide(
        layers({}, { "/db/lsm/snapshots": [".lock", ".DS_Store", "42", "active"] }),
      ),
    ),
  );

  it.effect("fails with SnapshotReadError when no numeric snapshots exist", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(findLatestLsmSnapshot("/db/lsm"));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const causeStr = String(result.cause);
        expect(causeStr).toContain("SnapshotReadError");
      }
    }).pipe(
      Effect.provide(layers({}, { "/db/lsm/snapshots": [".lock", "active"] })),
    ),
  );
});

describe("SnapshotReadError construction", () => {
  it("constructs cleanly with required fields", () => {
    const err = new SnapshotReadError({ message: "test", cause: "fixture" });
    expect(err._tag).toBe("SnapshotReadError");
    expect(err.message).toBe("test");
  });
});
