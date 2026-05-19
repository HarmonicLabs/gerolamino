#!/usr/bin/env node
// Node smoke driver — exercises the `lsm-wasm` TS adapter
// (`packages/ffi/src/lsm-wasm/`) against the compiled reactor module.
//
// Three sections, all hitting the same WASM module:
//   1. Legacy smoke (`smoke` + `smokeReopen`) — open/insert/lookup/close
//      and snapshot-persistence round-trip via the bundled high-level
//      ops in `hs_lsm_smoke`.
//   2. Handle-based API (`openSession`/`openTable`/`put`/`get`/`delete`
//      /`has`/`putBatch`/`deleteBatch`/`cursorOpen`/`cursorRead`
//      /`cursorClose`) — verifies the new wire format end-to-end.
//   3. `LsmModule.saveSnapshot` — writes a snapshot file via the
//      handle-based API and asserts it survives on disk.
//
// Run with `node --experimental-strip-types test-node-import.mjs`.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WASI } from "node:wasi";

import { Effect, Option, Stream } from "effect";

const { loadLsmModule } = await import(
  new URL("../../src/lsm-wasm/module-loader.ts", import.meta.url)
);
const { layerLsmWasm } = await import(
  new URL("../../src/lsm-wasm/blob-store.ts", import.meta.url)
);
const { BlobStore } = await import(new URL("../../src/blob-store.ts", import.meta.url));
const { LsmAdmin } = await import(new URL("../../src/lsm/admin.ts", import.meta.url));

const wasmBytes = await fs.readFile(new URL("./lsm-tree-wasm.wasm", import.meta.url));
const jsffiFactory = (await import(new URL("./lsm-tree-wasm.js", import.meta.url))).default;

// Build a fresh WASI per invocation — `wasi.start`/`initialize` is
// one-shot.
function makeWasi() {
  const wasi = new WASI({
    version: "preview1",
    args: ["lsm-tree-wasm"],
    env: { PATH: "", PWD: process.cwd() },
    preopens: { "/": "/" },
  });
  return {
    wasiImport: wasi.wasiImport,
    initialize: (instance) => wasi.initialize(instance),
  };
}

// ──────────────────────────────────────────────────────────────────
// Section 1 — legacy smoke functions (unchanged from prior wave)
// ──────────────────────────────────────────────────────────────────

async function legacySmokes() {
  const lsm = await Effect.runPromise(
    loadLsmModule({ wasmBytes, jsffiFactory, wasi: makeWasi() }),
  );
  console.log(
    "Haskell exports:",
    Object.keys(lsm.raw).filter((k) => k.startsWith("hs_")).sort(),
  );

  const dir1 = await fs.mkdtemp(path.join(os.tmpdir(), "lsm-wasm-smoke-"));
  console.log(`\n[smoke] session dir: ${dir1}`);
  const c1 = await Effect.runPromise(lsm.smoke(dir1));
  if (c1 !== 0) throw new Error(`smoke returned ${c1}`);
  const e1 = await fs.readdir(dir1);
  console.log(`[smoke] session-dir entries: ${e1.join(", ")}`);
  if (e1.length === 0) throw new Error("session dir is empty — lsm-tree wrote no state");
  await fs.rm(dir1, { recursive: true, force: true });

  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "lsm-wasm-reopen-"));
  console.log(`\n[reopen] session dir: ${dir2}`);
  const c2 = await Effect.runPromise(lsm.smokeReopen(dir2));
  if (c2 !== 0) throw new Error(`smokeReopen returned ${c2}`);
  const snaps = await fs.readdir(path.join(dir2, "snapshots")).catch(() => []);
  console.log(`[reopen] snapshots/ entries: ${snaps.join(", ")}`);
  if (!snaps.includes("wasm-smoke")) {
    throw new Error(`expected wasm-smoke snapshot under ${dir2}/snapshots`);
  }
  await fs.rm(dir2, { recursive: true, force: true });
}

// ──────────────────────────────────────────────────────────────────
// Section 2 — handle-based API via `LsmModule` directly
// ──────────────────────────────────────────────────────────────────

async function handleBasedApi() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lsm-wasm-handles-"));
  console.log(`\n[handles] session dir: ${dir}`);
  await Effect.runPromise(
    Effect.gen(function* () {
      const lsm = yield* loadLsmModule({ wasmBytes, jsffiFactory, wasi: makeWasi() });
      const session = yield* lsm.openSession(dir);
      const table = yield* lsm.openTable(session, "test-table");

      // put + get
      yield* lsm.put(table, new Uint8Array([1, 2, 3]), new Uint8Array([10, 20, 30]));
      const v1 = yield* lsm.get(table, new Uint8Array([1, 2, 3]));
      const got = Option.getOrUndefined(v1);
      if (!got || got[0] !== 10 || got[1] !== 20 || got[2] !== 30) {
        throw new Error(`get mismatch: ${got}`);
      }

      // miss
      const missing = yield* lsm.get(table, new Uint8Array([99]));
      if (Option.isSome(missing)) throw new Error("expected miss");

      // has
      if (!(yield* lsm.has(table, new Uint8Array([1, 2, 3])))) {
        throw new Error("has=false after put");
      }

      // delete
      yield* lsm.delete(table, new Uint8Array([1, 2, 3]));
      if (yield* lsm.has(table, new Uint8Array([1, 2, 3]))) {
        throw new Error("has=true after delete");
      }

      // putBatch
      yield* lsm.putBatch(table, [
        { key: new Uint8Array([0x10, 0x01]), value: new Uint8Array([0xa1]) },
        { key: new Uint8Array([0x10, 0x02]), value: new Uint8Array([0xa2]) },
        { key: new Uint8Array([0x10, 0x03]), value: new Uint8Array([0xa3]) },
      ]);
      const got2 = Option.getOrUndefined(yield* lsm.get(table, new Uint8Array([0x10, 0x02])));
      if (!got2 || got2[0] !== 0xa2) throw new Error(`putBatch get mismatch: ${got2}`);

      // cursor scan prefix [0x10]
      const cursor = yield* lsm.cursorOpen(table, new Uint8Array([0x10]));
      const batch = yield* lsm.cursorRead(cursor, 32);
      if (batch.entries.length !== 3) {
        throw new Error(`expected 3 prefix entries, got ${batch.entries.length}`);
      }
      yield* lsm.cursorClose(cursor);

      // deleteBatch
      yield* lsm.deleteBatch(table, [
        new Uint8Array([0x10, 0x01]),
        new Uint8Array([0x10, 0x02]),
      ]);
      if (yield* lsm.has(table, new Uint8Array([0x10, 0x01]))) {
        throw new Error("has=true after deleteBatch");
      }

      yield* lsm.closeTable(table);
      yield* lsm.closeSession(session);
    }),
  );
  console.log("[handles] all ops OK");
  await fs.rm(dir, { recursive: true, force: true });
}

// ──────────────────────────────────────────────────────────────────
// Section 3 — saveSnapshot via handle-based API
// ──────────────────────────────────────────────────────────────────

async function snapshotApi() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lsm-wasm-snapshot-"));
  console.log(`\n[snapshot] session dir: ${dir}`);
  await Effect.runPromise(
    Effect.gen(function* () {
      const lsm = yield* loadLsmModule({ wasmBytes, jsffiFactory, wasi: makeWasi() });
      const session = yield* lsm.openSession(dir);
      const table = yield* lsm.openTable(session, "to-snapshot");
      yield* lsm.put(table, new Uint8Array([1]), new Uint8Array([1, 1, 1]));
      yield* lsm.put(table, new Uint8Array([2]), new Uint8Array([2, 2, 2]));
      yield* lsm.saveSnapshot(table, "manual-snap", "test-label-v1");
      yield* lsm.closeTable(table);
      yield* lsm.closeSession(session);
    }),
  );
  const snapDir = path.join(dir, "snapshots", "manual-snap");
  const exists = await fs
    .stat(snapDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!exists) throw new Error(`expected snapshot dir at ${snapDir}`);
  console.log(`[snapshot] snapshot dir created: ${snapDir}`);
  await fs.rm(dir, { recursive: true, force: true });
}

await legacySmokes();
await handleBasedApi();
await snapshotApi();

console.log("\nLSM-TREE WASM CHAIN OK — legacy smoke + handle-based API + snapshot all green");
