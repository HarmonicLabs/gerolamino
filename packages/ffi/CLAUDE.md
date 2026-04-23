# ffi

Native FFI boundary for the node. Owns every `dlopen`/`bun:ffi` call and the
on-disk formats they touch. Renamed from `packages/lsm-tree` once the package's
role grew past "just LSM internals" — over time this package will also hold
Plutus off-chain eval, SPO crypto glue, and any other `.so`-backed subsystem.

## Current surface

- `BlobStore` / `BlobStoreError` — the shared binary KV service (get / put /
  delete / has / scan / putBatch / deleteBatch). Source of truth lives here;
  `storage` provides a thin re-export for callers that already depend on it.
- `utxoKey`, `blockKey`, `blockIndexKey`, `stakeKey`, `accountKey`,
  `snapshotKey`, `cborOffsetKey`, `prefixEnd` — 4-byte-prefix key encoders
  tied to the LSM scan semantics.
- `layerLsm(dir)` / `layerLsmFromSnapshot(dir, name?)` — `BlobStore` layer
  backed by the Haskell V2LSM library (`lsm-tree-lib`), wrapped in the Zig
  `bridge.zig` buffer-based API, loaded at runtime via Bun's `dlopen`.

## Source layout

```
src/
├── index.ts               top-level barrel — BlobStore + keys + ./lsm re-exports
├── blob-store.ts          BlobStore service + BlobStoreError (Schema.TaggedErrorClass)
├── keys.ts                4-byte-prefix key encoders (utxo/blk:/bidx/stak/acct/snap/coff) + prefixEnd
└── lsm/
    ├── index.ts           barrel — public surface of the LSM backend
    ├── ffi.ts             raw bun:ffi binding: BRIDGE_SYMBOLS, BridgeLib type, openBridge, LsmBridgeError, LsmBridgePath (Config)
    ├── layer-lsm.ts       BlobStore layer factories on top of openBridge
    ├── admin.ts           LsmAdmin service (snapshot save/openSnapshot)
    └── __tests__/
```

Future subsystems (Plutus off-chain eval, SPO crypto, etc.) land as sibling
directories under `src/` mirroring the `lsm/` pattern: `src/<subsystem>/ffi.ts`
for raw bindings, `src/<subsystem>/layer-*.ts` for Effect-facing layers, plus
a local `index.ts` barrel.

## V2LSM only

The distribution-2537.0 Mithril `snapshot-converter` produces V2LSM directly,
so we deliberately ship no LMDB backend. If a future workload needs a second
store type, it goes in a sibling subdirectory under `src/` — not a rewrite of
this one.

## On-disk dependencies

- `LIBLSM_BRIDGE_PATH` — absolute path to `liblsm-bridge.so` (the Zig wrapper
  around `liblsm-ffi.so`). Resolved via `Config.string`.
- The Haskell GHC RTS is initialized lazily on first FFI call via
  `bridge.zig`'s `init` export; callers never see the RTS boundary.

## Nix

`nix/packages/ffi.nix` builds three outputs:

- `lsm-tree-lib` — IOG's upstream `lsm-tree` Haskell library (kept as-is;
  this is the name the Haskell package registers under).
- `lsm-ffi` — our Haskell FFI wrapper (`haskell/lsm-ffi/src/LsmFFI.hs`).
- `lsm-bridge` — the Zig bridge shared library that Bun loads.

`liblsm-bridge.so` is baked into the bootstrap OCI image and the production
NixOS closure — never mount from host.

## Tests

```sh
bunx --bun vitest run packages/ffi
```

The Mithril-fixture smoke test is gated on `MITHRIL_FIXTURE_ENABLED=true`
and uses the `nix run .#download-mithril-lsm-snapshot` pipeline to produce
a reproducible V2LSM fixture byte-identical across hosts.
