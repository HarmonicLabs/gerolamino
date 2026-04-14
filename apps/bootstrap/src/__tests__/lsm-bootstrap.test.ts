/**
 * E2E test: bootstrap server reads V2LSM snapshot via BlobStore.
 *
 * Requires:
 *   - LIBLSM_BRIDGE_PATH pointing to liblsm-ffi.so
 *   - SNAPSHOT_PATH pointing to a V2LSM-converted Mithril snapshot
 *
 * Run: LIBLSM_BRIDGE_PATH=... SNAPSHOT_PATH=... bunx --bun vitest run apps/bootstrap/src/__tests__/lsm-bootstrap.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Effect, Layer, Stream } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { readSnapshotMeta, bootstrapStream, preloadLedgerFiles } from "../loader";
import { BootstrapMessageKind, decodeFrame } from "bootstrap";
import { layerLsm } from "lsm-tree";

const SNAPSHOT_PATH = process.env["SNAPSHOT_PATH"];
const LIBLSM_BRIDGE_PATH = process.env["LIBLSM_BRIDGE_PATH"];
const skip = !SNAPSHOT_PATH || !LIBLSM_BRIDGE_PATH;

describe.skipIf(skip)("Bootstrap server with V2LSM snapshot", () => {
  let lsmLayer: ReturnType<typeof layerLsm>;

  beforeAll(() => {
    lsmLayer = layerLsm(`${SNAPSHOT_PATH!}/lsm`);
  });

  const testLayers = () => Layer.mergeAll(BunFileSystem.layer, BunPath.layer, lsmLayer);

  it("reads snapshot metadata with LSM backend", async () => {
    const result = await readSnapshotMeta(SNAPSHOT_PATH!).pipe(
      Effect.provide(testLayers()),
      Effect.runPromise,
    );
    expect(result.protocolMagic).toBeGreaterThan(0);
    expect(result.snapshotSlot).toBeGreaterThan(0n);
    expect(result.totalChunks).toBeGreaterThan(0);
    expect(result.lsmDir).toContain("lsm");
  });

  it("bootstrap stream starts with Init frame", async () => {
    const frames = await readSnapshotMeta(SNAPSHOT_PATH!).pipe(
      Effect.flatMap((meta) => preloadLedgerFiles(meta).pipe(Effect.map((preloaded) => ({ meta, preloaded })))),
      Effect.flatMap(({ meta, preloaded }) => bootstrapStream(meta, preloaded).pipe(Stream.take(1), Stream.runCollect)),
      Effect.provide(testLayers()),
      Effect.runPromise,
    );
    expect(frames.length).toBe(1);
    const decoded = decodeFrame(frames[0]!);
    expect(decoded._tag).toBe(BootstrapMessageKind.Init);
  });

  it("bootstrap stream includes LedgerState and LedgerMeta", async () => {
    const tags = await readSnapshotMeta(SNAPSHOT_PATH!).pipe(
      Effect.flatMap((meta) => preloadLedgerFiles(meta).pipe(Effect.map((preloaded) => ({ meta, preloaded })))),
      Effect.flatMap(({ meta, preloaded }) =>
        bootstrapStream(meta, preloaded).pipe(
          Stream.take(3),
          Stream.map((frame) => decodeFrame(frame)._tag),
          Stream.runCollect,
        ),
      ),
      Effect.provide(testLayers()),
      Effect.runPromise,
    );
    expect(tags).toEqual([BootstrapMessageKind.Init, BootstrapMessageKind.LedgerState, BootstrapMessageKind.LedgerMeta]);
  });

  it("streams UTxO entries from LSM via BlobStore.scan", async () => {
    const tags = await readSnapshotMeta(SNAPSHOT_PATH!).pipe(
      Effect.flatMap((meta) => preloadLedgerFiles(meta).pipe(Effect.map((preloaded) => ({ meta, preloaded })))),
      Effect.flatMap(({ meta, preloaded }) =>
        bootstrapStream(meta, preloaded).pipe(
          Stream.take(10), // Init + State + Meta + some UTxO batches
          Stream.map((frame) => decodeFrame(frame)._tag),
          Stream.runCollect,
        ),
      ),
      Effect.provide(testLayers()),
      Effect.runPromise,
    );
    // After Init, LedgerState, LedgerMeta we should see BlobEntries (UTxO batches)
    expect(tags.length).toBeGreaterThanOrEqual(4);
    expect(tags[3]).toBe(BootstrapMessageKind.BlobEntries);
  });

  it("complete stream ends with Complete frame", async () => {
    const lastTag = await readSnapshotMeta(SNAPSHOT_PATH!).pipe(
      Effect.flatMap((meta) => preloadLedgerFiles(meta).pipe(Effect.map((preloaded) => ({ meta, preloaded })))),
      Effect.flatMap(({ meta, preloaded }) =>
        bootstrapStream(meta, preloaded).pipe(
          Stream.runCollect,
          Effect.map((frames) => {
            const last = frames[frames.length - 1];
            return last ? decodeFrame(last)._tag : undefined;
          }),
        ),
      ),
      Effect.provide(testLayers()),
      Effect.runPromise,
    );
    expect(lastTag).toBe(BootstrapMessageKind.Complete);
  }, 120_000); // Long timeout for full stream
});
