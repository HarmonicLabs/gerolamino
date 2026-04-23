/**
 * Property tests for the LSM BlobStore + LsmAdmin layer.
 *
 * Exercises the full round-trip the plan calls for:
 *   open → write → read-back → snapshot → open-from-snapshot → read-back.
 *
 * The snapshot restore runs within a single session via `admin.openSnapshot`
 * (swaps the table handle, session stays open). Using `layerLsmFromSnapshot`
 * inside one process would trip the LSM library's per-directory session
 * lock because the Zig bridge has no session-close export.
 *
 * Each FastCheck run uses a freshly-mkdtemp'd subdirectory so every run
 * gets an empty store; paths never collide across runs.
 */
import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { type BlobEntry, BlobStore } from "../../blob-store.ts";
import { LsmAdmin } from "../admin";
import { layerLsm } from "../layer-lsm";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LIBLSM_BRIDGE_PATH = process.env["LIBLSM_BRIDGE_PATH"];
const skip = !LIBLSM_BRIDGE_PATH;

const SNAPSHOT_NAME = "property-test-snap";
const SNAPSHOT_LABEL = "UTxO table";

/** Deduplicate entries by key — LSM semantics are last-write-wins per key. */
const dedupeByKey = (entries: ReadonlyArray<BlobEntry>) => {
  const seen = new Map<string, BlobEntry>();
  for (const entry of entries) {
    const hex = Array.from(entry.key, (b) => b.toString(16).padStart(2, "0")).join("");
    seen.set(hex, entry);
  }
  return Array.from(seen.values());
};

/** Lex-compare two Uint8Arrays. Returns negative / 0 / positive per standard cmp. */
const lexCompare = (a: Uint8Array, b: Uint8Array): number => {
  const len = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.byteLength - b.byteLength;
};

/** Check whether `key` starts with `prefix`. */
const startsWith = (key: Uint8Array, prefix: Uint8Array): boolean => {
  if (prefix.byteLength > key.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i++) if (key[i] !== prefix[i]) return false;
  return true;
};

describe.skipIf(skip)("LSM layer snapshot round-trip", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsm-prop-"));
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it.effect.prop(
    "scan(prefix) returns only keys with that prefix, in lex-ascending order, no duplicates, covering every written key",
    [
      FastCheck.uint8Array({ minLength: 1, maxLength: 8 }),
      FastCheck.array(
        FastCheck.record({
          suffix: FastCheck.uint8Array({ minLength: 1, maxLength: 16 }),
          value: FastCheck.uint8Array({ minLength: 0, maxLength: 64 }),
        }),
        { minLength: 1, maxLength: 32 },
      ),
      FastCheck.array(
        FastCheck.record({
          key: FastCheck.uint8Array({ minLength: 1, maxLength: 16 }),
          value: FastCheck.uint8Array({ minLength: 0, maxLength: 64 }),
        }),
        { minLength: 0, maxLength: 16 },
      ),
    ],
    ([prefix, matchingRaw, outsiders]) => {
      const localSession = fs.mkdtempSync(path.join(sessionDir, "run-"));

      const matching = matchingRaw.map(({ suffix, value }) => {
        const key = new Uint8Array(prefix.byteLength + suffix.byteLength);
        key.set(prefix, 0);
        key.set(suffix, prefix.byteLength);
        return { key, value };
      });

      const outside = outsiders
        .map((o) => ({ key: o.key, value: o.value }))
        .filter((o) => !startsWith(o.key, prefix));

      const allEntries = dedupeByKey([...matching, ...outside]);
      const expectedMatches = dedupeByKey(
        allEntries.filter((e) => startsWith(e.key, prefix)),
      ).toSorted((a, b) => lexCompare(a.key, b.key));

      return Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* store.putBatch(allEntries);

        const results: Array<BlobEntry> = [];
        yield* Stream.runForEach(store.scan(prefix), (entry) =>
          Effect.sync(() => {
            results.push({ key: entry.key, value: entry.value });
          }),
        );

        for (const { key } of results) expect(startsWith(key, prefix)).toBe(true);

        for (let i = 1; i < results.length; i++)
          expect(lexCompare(results[i - 1]!.key, results[i]!.key)).toBeLessThan(0);

        expect(results.length).toBe(expectedMatches.length);
        for (let i = 0; i < results.length; i++) {
          expect(results[i]!.key).toEqual(expectedMatches[i]!.key);
          expect(results[i]!.value).toEqual(expectedMatches[i]!.value);
        }
      }).pipe(Effect.provide(layerLsm(localSession)));
    },
    { fastCheck: { numRuns: 5 } },
  );

  it.effect.prop(
    "written entries round-trip byte-exact through snapshot + openSnapshot",
    [
      FastCheck.array(
        FastCheck.record({
          key: FastCheck.uint8Array({ minLength: 1, maxLength: 64 }),
          value: FastCheck.uint8Array({ minLength: 0, maxLength: 256 }),
        }),
        { minLength: 1, maxLength: 16 },
      ),
    ],
    ([rawEntries]) => {
      const entries = dedupeByKey(rawEntries);
      const localSession = fs.mkdtempSync(path.join(sessionDir, "run-"));

      return Effect.gen(function* () {
        const store = yield* BlobStore;
        const admin = yield* LsmAdmin;

        yield* store.putBatch(entries);

        for (const entry of entries) {
          const pre = yield* store.get(entry.key);
          expect(Option.getOrUndefined(pre)).toEqual(entry.value);
        }

        yield* admin.snapshot(SNAPSHOT_NAME, SNAPSHOT_LABEL);
        yield* admin.openSnapshot(SNAPSHOT_NAME, SNAPSHOT_LABEL);

        for (const entry of entries) {
          const post = yield* store.get(entry.key);
          expect(Option.getOrUndefined(post)).toEqual(entry.value);
        }
      }).pipe(Effect.provide(layerLsm(localSession)));
    },
    { fastCheck: { numRuns: 5 } },
  );
});
