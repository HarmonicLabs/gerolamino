/**
 * End-to-end BlobStore parity tests for the WASM lsm-tree layer.
 *
 * Exercises the full chain: `loadLsmModule` → `layerLsmWasm` → real
 * `BlobStore` operations (put/get/delete/has/scan/putBatch/deleteBatch)
 * against the compiled `lsm-tree-wasm.wasm` reactor module, using
 * Bun's `node:wasi` + the `bun-wasi.ts` polyfill for reactor mode.
 *
 * Skipped when the WASM artifacts haven't been built — gate via the
 * existence of `lsm-tree-wasm.wasm` next to its `.js` stub. Build
 * with `packages/ffi/haskell/lsm-tree-wasm-shim/build.sh`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { LsmWasmBunRuntimeTests } from "../../../__tests__/lsm-wasm-test-config.ts";
import { BlobStore } from "../../blob-store.ts";
import { LsmAdmin } from "../../admin.ts";
import { makeBunWasi } from "../bun-wasi.ts";
import { layerLsmWasm } from "../blob-store.ts";

// Absolute path to the built shim artifacts. The `.wasm` + `.js`
// pair is produced by `haskell/lsm-tree-wasm-shim/build.sh`.
const SHIM_DIR = new URL("../../../haskell/lsm-tree-wasm-shim/", import.meta.url).pathname;
const WASM_PATH = `${SHIM_DIR}lsm-tree-wasm.wasm`;
const JS_PATH = `${SHIM_DIR}lsm-tree-wasm.js`;

// Sync skip gate uses `Bun.file().size > 0` instead of `node:fs.existsSync`.
// Bun.file returns 0 size for non-existent files, so a positive size is a
// sufficient (and Bun-native) existence + non-empty check for the artifact.
// Bun's `node:wasi` polyfill in `bun-wasi.ts` works for single-buffer
// reactor calls (the legacy `hs_lsm_smoke`/`hs_lsm_smoke_reopen` path),
// but the multi-malloc / out-pointer-read pattern used by the BlobStore
// Layer trips a WASM "out of bounds memory access" trap under Bun. The
// upstream fix is on Bun's `claude/fix-wasi-initialize-12755` branch;
// these tests will run once that lands.
const wasmRuntimeEnabled = Effect.runSync(LsmWasmBunRuntimeTests.pipe(Effect.orDie));

const skip =
  !wasmRuntimeEnabled ||
  Bun.file(WASM_PATH).size === 0 ||
  Bun.file(JS_PATH).size === 0;

const TestPlatformLayer = Layer.mergeAll(BunFileSystem.layer, Path.layer);

const acquireRunDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "lsm-wasm-blobstore-" }),
);

const loadWasmBytes = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.readFile(WASM_PATH).pipe(
    Effect.map((raw) => {
      const copy = new Uint8Array(new ArrayBuffer(raw.byteLength));
      copy.set(raw);
      return copy;
    }),
  ),
);

// JSFFI factory module is loaded dynamically — its path is build-output
// relative and the file may not exist on a fresh checkout, so a top-level
// static import would break the entire test module's load.
const loadJsffiFactory = Effect.tryPromise({
  try: async () =>
    (await import(/* @vite-ignore */ JS_PATH)).default as (
      __exports: Record<string, unknown>,
    ) => WebAssembly.ModuleImports,
  catch: (cause) => new Error(`failed to import JSFFI factory at ${JS_PATH}`, { cause }),
});

describe.skipIf(skip)("layerLsmWasm — BlobStore parity", () => {
  const withWasmLayer = <A, E>(
    body: Effect.Effect<A, E, BlobStore | LsmAdmin>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* acquireRunDir;
        const wasmBytes = yield* loadWasmBytes;
        const jsffiFactory = yield* loadJsffiFactory;
        return yield* body.pipe(
          Effect.provide(
            layerLsmWasm({
              wasmBytes,
              jsffiFactory,
              wasi: makeBunWasi({ preopens: { "/": "/" } }),
              sessionDir: tmpDir,
            }),
          ),
        );
      }),
    ).pipe(Effect.provide(TestPlatformLayer));

  it.effect("put + get round-trip", () =>
    withWasmLayer(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const key = new Uint8Array([0x01, 0x02, 0x03]);
        const value = new Uint8Array([0xaa, 0xbb, 0xcc]);
        yield* store.put(key, value);
        const got = yield* store.get(key);
        expect(Option.getOrUndefined(got)).toEqual(value);
      }),
    ),
  );

  it.effect("get on missing key returns Option.none", () =>
    withWasmLayer(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const got = yield* store.get(new Uint8Array([0xff, 0xee]));
        expect(Option.isNone(got)).toBe(true);
      }),
    ),
  );

  it.effect("has reflects put + delete", () =>
    withWasmLayer(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const key = new Uint8Array([0x42]);
        expect(yield* store.has(key)).toBe(false);
        yield* store.put(key, new Uint8Array([0x01]));
        expect(yield* store.has(key)).toBe(true);
        yield* store.delete(key);
        expect(yield* store.has(key)).toBe(false);
      }),
    ),
  );

  it.effect("putBatch inserts every entry", () =>
    withWasmLayer(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const entries = [
          { key: new Uint8Array([0x10]), value: new Uint8Array([0xa1]) },
          { key: new Uint8Array([0x11]), value: new Uint8Array([0xa2]) },
          { key: new Uint8Array([0x12]), value: new Uint8Array([0xa3]) },
        ];
        yield* store.putBatch(entries);
        for (const { key, value } of entries) {
          const got = yield* store.get(key);
          expect(Option.getOrUndefined(got)).toEqual(value);
        }
      }),
    ),
  );

  it.effect("deleteBatch removes every key", () =>
    withWasmLayer(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const keys = [new Uint8Array([0x20]), new Uint8Array([0x21])];
        yield* store.putBatch(keys.map((k) => ({ key: k, value: new Uint8Array([1]) })));
        yield* store.deleteBatch(keys);
        for (const k of keys) expect(yield* store.has(k)).toBe(false);
      }),
    ),
  );

  it.effect("scan returns prefix-matched entries in order", () =>
    withWasmLayer(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        const entries = [
          { key: new Uint8Array([0x10, 0x01]), value: new Uint8Array([0x01]) },
          { key: new Uint8Array([0x10, 0x02]), value: new Uint8Array([0x02]) },
          { key: new Uint8Array([0x10, 0x03]), value: new Uint8Array([0x03]) },
          { key: new Uint8Array([0x20, 0x00]), value: new Uint8Array([0xff]) },
        ];
        yield* store.putBatch(entries);
        const got = yield* Stream.runCollect(store.scan(new Uint8Array([0x10])));
        const collected = Array.from(got);
        expect(collected.length).toBe(3);
        for (let i = 0; i < 3; i++) {
          expect(collected[i]?.key[1]).toBe(i + 1);
        }
      }),
    ),
  );

  it.effect("LsmAdmin.snapshot creates a snapshot directory on disk", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tmpDir = yield* acquireRunDir;
        const wasmBytes = yield* loadWasmBytes;
        const jsffiFactory = yield* loadJsffiFactory;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* Effect.gen(function* () {
          const store = yield* BlobStore;
          const admin = yield* LsmAdmin;
          yield* store.put(new Uint8Array([1]), new Uint8Array([1]));
          yield* admin.snapshot("test-snap", "test-label");
          const snapshotDir = path.join(tmpDir, "snapshots", "test-snap");
          expect(yield* fs.exists(snapshotDir)).toBe(true);
        }).pipe(
          Effect.provide(
            layerLsmWasm({
              wasmBytes,
              jsffiFactory,
              wasi: makeBunWasi({ preopens: { "/": "/" } }),
              sessionDir: tmpDir,
            }),
          ),
        );
      }),
    ).pipe(Effect.provide(TestPlatformLayer)),
  );
});
