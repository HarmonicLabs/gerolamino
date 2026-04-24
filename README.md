# Gerolamino

In-browser Cardano node. A Bun workspaces monorepo with reproducible Nix
builds, Effect v4 throughout, and a Rust/WASM crypto layer.

## Quick start

```bash
# Enter the dev shell (requires Nix with flakes)
nix develop

# Install dependencies (postinstall regenerates bun.nix via bun2nix)
bun install

# Build all TypeScript packages
bunx --bun tsgo --build

# Run the test suite
bunx --bun vitest run
```

## Packages

| Package                  | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `packages/codecs`        | CBOR + MemPack derivation over Effect Schema (foundation, no deps)   |
| `packages/ledger`        | Cardano ledger decoders, 100% Mithril snapshot coverage (Byron→Conway) |
| `packages/miniprotocols` | Ouroboros N2N + N2C mini-protocols + Effect-native multiplexer       |
| `packages/storage`       | ImmutableDB / VolatileDB / LedgerDB / ChainDB over BlobStore + SqlClient |
| `packages/bootstrap`     | Bootstrap WebSocket client library (schema-first TLV framing)        |
| `packages/wasm-plexer`   | Rust→WASM multiplexer frame codec                                    |
| `packages/wasm-utils`    | Rust→WASM crypto (blake2b tagged, ed25519, KES Sum6, VRF, leader math) |
| `packages/consensus`     | Ouroboros Praos consensus (header validation, chain selection, nonce, SyncStage, ChainEventLog, HFC era-history) |
| `packages/ffi`           | Bun FFI over Zig → Haskell V2LSM `BlobStore` + on-disk key encoders  |
| `packages/dashboard`     | Render-backend-agnostic Solid.js dashboard components + Effect Atoms |
| `packages/chrome-ext`    | Browser-side sync worker (deferred — ripe once core is frozen)       |
| `apps/bootstrap`         | HTTP + WS server: streams Mithril snapshot data to browser clients   |
| `apps/tui`               | Bun CLI: relay sync + consensus validation + Atom-backed dashboard   |

See `docs/architecture.md` for the full dependency graph + distributed-system
primitive mapping.

## Building with Nix

All packages are built reproducibly. TypeScript packages use bun2nix (for
dependency copy) + tsgo `--build` for type-checking. Rust packages use
Crane. Zig code for the LSM FFI bridge uses zig2nix.

```bash
# TypeScript
nix build .#ts-packages

# WASM (Rust → wasm-bindgen)
nix build .#wasm-plexer
nix build .#wasm-utils

# Zig FFI bridge + Haskell LSM library
nix build .#lsm-bridge

# Bootstrap server OCI image (streamLayeredImage via nix2container)
nix build .#bootstrap-image
```

`nix flake check --allow-import-from-derivation` runs the full validation
matrix including treefmt + deploy-rs schema checks.

## Bootstrap server

Serves Mithril V2LSM snapshot data to browser clients over WebSocket, then
proxies miniprotocol traffic to an upstream Cardano relay. HTTP endpoints
follow an HttpApi contract with auto-generated OpenAPI at `/openapi.json`
and a Swagger UI at `/docs`.

Required at runtime:
- `LIBLSM_BRIDGE_PATH=/path/to/liblsm-bridge.so` (from `nix build .#lsm-bridge`)
- A V2LSM-format snapshot (Mithril distribution 2537.0+, or a local
  cardano-node 10.7.x database).

```bash
# --- Option A (dev default): rsync the live V2LSM db from production ---
ssh root@178.156.252.81 'zfs snapshot zroot/data@dev-$(date +%s)'
rsync -aP --info=progress2 \
  root@178.156.252.81:/data/.zfs/snapshot/dev-<ts>/cardano-node/db/ \
  .devenv/state/prod-snapshot/
ssh root@178.156.252.81 'zfs destroy zroot/data@dev-<ts>'

LIBLSM_BRIDGE_PATH=$(nix build .#lsm-bridge --print-out-paths)/lib/liblsm-bridge.so \
  bun run apps/bootstrap/src/cli.ts serve \
  -d .devenv/state/prod-snapshot -n preprod

# --- Option B: download a Mithril snapshot + LSM-convert (requires prod ---
# --- aggregator to have produced a signed snapshot) ---
nix run .#download-mithril-lsm-snapshot -- preprod /tmp/snapshot
LIBLSM_BRIDGE_PATH=$(nix build .#lsm-bridge --print-out-paths)/lib/liblsm-bridge.so \
  bun run apps/bootstrap/src/cli.ts serve -s /tmp/snapshot -n preprod

# --- Container run (baked liblsm-bridge.so) ---
nix build .#bootstrap-image
./result | podman load
podman run --rm -p 3040:3040 -v .devenv/state/prod-snapshot:/data:ro \
  ghcr.io/harmoniclabs/bootstrap:latest
```

**Why the rsync path**: upstream Mithril aggregator still signs cardano-node
v10.6.2 snapshots (pre-10.7 table format). The `snapshot-converter --utxo-hd-flavor
LSM` call is version-gated on `tablesCodecVersion` metadata (introduced in 10.7),
so upstream snapshots cannot be converted client-side. The production box runs
master-track cardano-node which writes V2LSM tables natively — rsyncing from
`/data/cardano-node/db/` sidesteps the conversion entirely. Long-term, the
self-hosted `mithril-aggregator` will emit matching-format snapshots once a
signer is registered (see `docs/deployment.md`).

## TUI node

```bash
bun run apps/tui/src/index.ts start \
  --bootstrap-url ws://localhost:3040/bootstrap \
  --relay-host preprod-node.play.dev.cardano.org --relay-port 3001 \
  --network preprod
```

## Deployment

Production NixOS configuration targets `decentralizationmaxi.io` via
deploy-rs with magic rollback. SSH is on port 2222 (key-only).

```bash
# Build the NixOS closure (eval-only check)
nix build .#nixosConfigurations.production.config.system.build.toplevel

# Deploy with magic rollback
nix run github:serokell/deploy-rs -- .#production
```

The production host runs `cardano-node` (preprod, V2LSM, master-tracked) +
a self-hosted `mithril-aggregator` + `mithril-signer` single-signer cluster
(produces snapshots whose metadata matches our cardano-node version — see
`nix/machine-configs/mithril-services.nix`).

Cachix substituter `harmoniclabs.cachix.org` is the project binary cache
(CI pushes main-branch builds; wiring via `cachix/cachix-action@v15`).

## Testing

```bash
# Full monorepo
bunx --bun vitest run

# Single package
bunx --bun vitest run packages/consensus

# Integration tests against a live preprod relay
VITE_INTEGRATION=1 bunx --bun vitest run packages/miniprotocols
```

Test discipline: `@effect/vitest` `it.effect` / `it.layer` / `it.prop`.
`Effect.runPromise` only at `apps/*/src/{index,cli,main}.ts` entrypoints.

## Project structure

```
flake.nix                 # flake-parts root (inputs, nixConfig, deploy nodes)
flake.lock                # pinned inputs
bun.nix                   # bun2nix-regenerated dependency graph (DO commit)
nix/
  packages/               # Nix derivations (TS + Rust + Zig + containers)
  apps/                   # nix-app wrappers (download-mithril-lsm-snapshot, ...)
  machine-configs/        # NixOS configs (production + mithril-services + disko)
docs/
  architecture.md         # distributed-system map
  deployment.md           # production provisioning (KES keys, op-certs)
packages/                 # TypeScript + Rust sources
apps/                     # executable entrypoints
```

## Conventions

- Never use `as T` casts (`as const` only). Use Effect Schema for validation.
- `Schema.TaggedClass` for domain types with methods; `Schema.TaggedErrorClass`
  for errors; `Schema.Struct` for plain records.
- `Effect.gen` + `yield*`, not nested `Effect.flatMap`.
- `Config.string()` for env vars, never `process.env`.
- `Effect.log*`, never `console.*`.
- `tsgo --noEmit`, never stock `tsc`.
- Every `src/<dir>/` carries an `index.ts` barrel; imports use directory
  paths, not per-file.

Full rules in `AGENTS.md` and per-package `CLAUDE.md` files.
