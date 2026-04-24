/**
 * E2E test: bootstrap server reads V2LSM snapshot via BlobStore.
 *
 * Accepts either of two data sources (tried in order):
 *   - SNAPSHOT_PATH — Mithril V2LSM-converted snapshot (layerLsm mode)
 *   - NODE_DB_PATH  — cardano-node database directory with native V2LSM
 *                     (layerLsmFromSnapshot mode; hard-links latest snapshot)
 *
 * Requires LIBLSM_BRIDGE_PATH pointing to liblsm-bridge.so.
 *
 * Default dev fixture (per README): `.devenv/state/prod-snapshot` rsynced
 * from the production cardano-node box.
 *
 * Run: LIBLSM_BRIDGE_PATH=... NODE_DB_PATH=.devenv/state/prod-snapshot \
 *      bunx --bun vitest run apps/bootstrap/src/__tests__/lsm-bootstrap.test.ts
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { bootstrapStream, preloadLedgerFiles } from "../loader";
import { readSnapshotMeta, readNodeDbMeta, BootstrapMessageKind, decodeFrame } from "bootstrap";
import { layerLsm, layerLsmFromSnapshot } from "lsm-ffi";

const SNAPSHOT_PATH = process.env["SNAPSHOT_PATH"];
const NODE_DB_PATH = process.env["NODE_DB_PATH"];
const NETWORK = process.env["NETWORK"] ?? "preprod";
const LIBLSM_BRIDGE_PATH = process.env["LIBLSM_BRIDGE_PATH"];
const skip = (!SNAPSHOT_PATH && !NODE_DB_PATH) || !LIBLSM_BRIDGE_PATH;

const platformLayers = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const loadMeta = Effect.gen(function* () {
  if (SNAPSHOT_PATH) {
    const meta = yield* readSnapshotMeta(SNAPSHOT_PATH);
    return { meta, lsmLayer: layerLsm(meta.lsmDir) };
  }
  const { meta, snapshotName } = yield* readNodeDbMeta(NODE_DB_PATH!, NETWORK);
  return { meta, lsmLayer: layerLsmFromSnapshot(meta.lsmDir, snapshotName) };
});

describe.skipIf(skip)("Bootstrap server with V2LSM snapshot", () => {
  it.effect("reads snapshot metadata with LSM backend", () =>
    Effect.gen(function* () {
      const { meta } = yield* loadMeta;
      expect(meta.protocolMagic).toBeGreaterThan(0);
      expect(meta.snapshotSlot).toBeGreaterThan(0n);
      expect(meta.totalChunks).toBeGreaterThan(0);
      expect(meta.lsmDir).toContain("lsm");
    }).pipe(Effect.provide(platformLayers)),
  );

  it.effect("bootstrap stream starts with Init frame", () =>
    Effect.gen(function* () {
      const { meta, lsmLayer } = yield* loadMeta;
      const preloaded = yield* preloadLedgerFiles(meta);
      const frames = yield* bootstrapStream(meta, preloaded).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.provide(lsmLayer),
      );
      expect(frames.length).toBe(1);
      const decoded = decodeFrame(frames[0]!);
      expect(decoded._tag).toBe(BootstrapMessageKind.Init);
    }).pipe(Effect.provide(platformLayers)),
  );

  it.effect("bootstrap stream includes LedgerState and LedgerMeta", () =>
    Effect.gen(function* () {
      const { meta, lsmLayer } = yield* loadMeta;
      const preloaded = yield* preloadLedgerFiles(meta);
      const tags = yield* bootstrapStream(meta, preloaded).pipe(
        Stream.take(3),
        Stream.map((frame) => decodeFrame(frame)._tag),
        Stream.runCollect,
        Effect.provide(lsmLayer),
      );
      expect(tags).toEqual([
        BootstrapMessageKind.Init,
        BootstrapMessageKind.LedgerState,
        BootstrapMessageKind.LedgerMeta,
      ]);
    }).pipe(Effect.provide(platformLayers)),
  );

  it.effect("streams UTxO entries from LSM via BlobStore.scan", () =>
    Effect.gen(function* () {
      const { meta, lsmLayer } = yield* loadMeta;
      const preloaded = yield* preloadLedgerFiles(meta);
      const tags = yield* bootstrapStream(meta, preloaded).pipe(
        Stream.take(10),
        Stream.map((frame) => decodeFrame(frame)._tag),
        Stream.runCollect,
        Effect.provide(lsmLayer),
      );
      expect(tags.length).toBeGreaterThanOrEqual(4);
      expect(tags[3]).toBe(BootstrapMessageKind.BlobEntries);
    }).pipe(Effect.provide(platformLayers)),
  );

  it.effect(
    "complete stream ends with Complete frame",
    () =>
      Effect.gen(function* () {
        const { meta, lsmLayer } = yield* loadMeta;
        const preloaded = yield* preloadLedgerFiles(meta);
        const frames = yield* bootstrapStream(meta, preloaded).pipe(
          Stream.runCollect,
          Effect.provide(lsmLayer),
        );
        const last = frames[frames.length - 1];
        const lastTag = last ? decodeFrame(last)._tag : undefined;
        expect(lastTag).toBe(BootstrapMessageKind.Complete);
      }).pipe(Effect.provide(platformLayers)),
    { timeout: 900_000 },
  );
});
