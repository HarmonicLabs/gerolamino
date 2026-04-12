# Gerolamino

In-browser Cardano node. A Bun workspaces monorepo with reproducible Nix builds.

## Quick start

```bash
# Enter the dev shell (requires Nix with flakes)
nix develop

# Install dependencies
bun install

# Build all TypeScript packages
bunx --bun tsc --build
```

## Packages

| Package                  | Description                                                         |
| ------------------------ | ------------------------------------------------------------------- |
| `packages/cbor-schema`   | CBOR schema definition and validation                               |
| `packages/ledger`        | Cardano ledger type decoders (full Mithril snapshot coverage)       |
| `packages/miniprotocols` | Ouroboros miniprotocol implementation (ChainSync, BlockFetch, etc.) |
| `packages/storage`       | Storage layer with XState state machines and Effect-TS              |
| `packages/bootstrap`     | Bootstrap WebSocket protocol library                                |
| `packages/wasm-plexer`   | Rust WASM protocol multiplexer                                      |
| `packages/wasm-utils`    | Rust WASM crypto primitives (blake2b, ed25519, bech32, KES)         |
| `apps/bootstrap`         | Bootstrap server -- streams Mithril snapshots to browser clients    |

## Building with Nix

All packages are built reproducibly with Nix. The TypeScript packages use bun2nix for dependency management and tsc --build for type-checking. The Rust packages use Crane.

```bash
# Build the bootstrap server app
nix build .#bootstrap-app

# Build the bootstrap OCI container image
nix build .#bootstrap-image

# Build all TypeScript packages
nix build .#ts-packages

# Build WASM packages
nix build .#wasm-plexer
nix build .#wasm-utils
```

## Bootstrap server

The bootstrap server streams a Mithril Cardano snapshot (~16 GB) to in-browser nodes via WebSocket. It requires `liblmdb.so` at runtime for reading the LMDB-formatted ledger state -- this native dependency is why Nix is used for builds (it pins the exact `liblmdb.so` version and injects the path via the `LIBLMDB_PATH` environment variable). See [apps/bootstrap/README.md](apps/bootstrap/README.md) for full details.

```bash
# Download the latest Mithril snapshot
nix run .#download-snapshot -- /var/lib/gerolamino/snapshot

# Build and load the container image
nix build .#bootstrap-image
./result | podman load

# Run the container
podman run --rm -p 3040:3040 \
  -v /var/lib/gerolamino/snapshot:/data:ro \
  ghcr.io/harmoniclabs/bootstrap:latest
```

## Deployment

The production server at `decentralizationmaxi.io` is managed as a NixOS configuration with deploy-rs for rollback-safe deployments.

```bash
# Deploy to production (with magic rollback)
nix run github:serokell/deploy-rs -- .#production
```

Pushes to `main` trigger automatic deployment via GitHub Actions.

## CI/CD

GitHub Actions runs on every push to `main`:

1. **Build**: Compiles the bootstrap app and its WASM/TS dependencies
2. **Deploy**: Deploys the NixOS configuration to production via deploy-rs with magic rollback

The CI runner uses a custom Arch Linux container with Determinate Nix (`ghcr.io/harmoniclabs/gerolamino-ci`).

## Project structure

```
flake.nix                 # Nix flake (flake-parts)
nix/
  packages/               # Nix package derivations
    ts-packages.nix        # bun2nix + tsc --build TypeScript build
    bootstrap-image.nix    # OCI container image
    wasm-plexer.nix        # Rust WASM (Crane)
    wasm-utils.nix         # Rust WASM (Crane)
    libsodium-vrf-wasm.nix # C WASM (zig cc)
  apps/                   # Nix app definitions
    download-snapshot.nix  # Mithril snapshot downloader
  machine-configs/        # NixOS configurations
    production.nix         # Production server (decentralizationmaxi.io)
packages/                 # TypeScript/Rust source packages
apps/                     # Application source code
```
