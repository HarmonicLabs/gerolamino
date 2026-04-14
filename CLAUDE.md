# Gerolamino

In-browser Cardano node. Bun workspaces monorepo with Effect-TS, Rust/WASM
crypto, and Nix-based build/deploy pipeline.

## Architecture

```
packages/cbor-schema     <- CBOR encoding/decoding (foundation, no internal deps)
packages/ledger          <- Cardano ledger model (depends: cbor-schema, wasm-utils)
packages/miniprotocols   <- Ouroboros network protocols (depends: cbor-schema, wasm-plexer)
packages/storage         <- Storage abstraction with XState machines (depends: effect, xstate)
packages/bootstrap       <- Bootstrap protocol client (depends: effect)
packages/wasm-plexer     <- Multiplexer WASM (Rust, bindgen target: bundler)
packages/wasm-utils      <- Crypto primitives WASM (Rust nightly, bindgen target: web)
packages/chrome-ext      <- Chrome extension (Solid.js + WXT)
packages/consensus       <- Ouroboros Praos consensus (depends: ledger, cbor-schema, storage)
packages/lsm-tree        <- LSM-tree FFI bindings (Haskell V2LSM via GHC WASM)
packages/dashboard       <- (placeholder)
apps/bootstrap           <- Bootstrap HTTP server (Effect CLI + Bun + LMDB)
apps/tui                 <- TUI node: relay sync + consensus validation
```

## Tech Stack

- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript 5.9+, Rust (WASM targets)
- **Monorepo**: Bun workspaces + tsc --build project references
- **Effects**: Effect ^4.0.0-beta.47 (all packages)
- **State machines**: XState ^5.30 (storage, miniprotocols, chrome-ext)
- **Testing**: `bunx --bun vitest` (Bun v1.3.11+ required)
- **Nix**: flake-parts + bun2nix + crane + deploy-rs
- **CI**: GitHub Actions with Arch Linux + Determinate Nix container
- **Deploy**: deploy-rs to `decentralizationmaxi.io` (NixOS, Podman)

## Coding Conventions

- **Never use `as Type`** typecasts or `any`. Only `as const` is allowed. Use
  Effect pipelines and Schema for type safety.
- **Use `Schema.TaggedClass`** (not branded types) for domain types that need
  methods. Use `Schema.TaggedErrorClass` for error types. Use `Schema.Struct`
  for plain data records, `Schema.Literals([...])` for string literal unions.
- **Use `Effect.gen` with `yield*`**, not nested `Effect.flatMap` chains.
- **Use `Config.string()`** for environment variables, not `process.env`.
- **Use `Effect.run*` only at entrypoints** (apps/tui, apps/bootstrap). All
  core logic stays inside Effect. Tests use `@effect/vitest` `it.effect` and
  `layer()` — never `Effect.runPromise` in test helpers.
- **All imports at top of file** - no dynamic `import()` inside functions.
- **No lodash** - use native Array methods (`Array.from`, `for` loops, etc.).
- **Prefer Bun-native crypto** (Bun.CryptoHasher for blake2b). WASM only for
  ed25519, KES Sum6, VRF, and leader threshold math.
- **All runtime ops use Effect abstractions**: Clock for time, Ref for state,
  Config for env, Schedule for retries — not raw JS/Bun APIs.
- Cross-package imports use `tsconfig.base.json` path aliases (e.g.,
  `import { ... } from "ledger/lib/block/block.ts"`).

## Building

### TypeScript (via tsc --build)

```sh
bunx --bun tsc --build                                          # all packages
bunx --bun tsc --build packages/ledger/tsconfig.lib.json        # single
bunx --bun tsc --noEmit -p packages/ledger/tsconfig.lib.json    # type-check only
```

Build targets come from `tsconfig.lib.json` files (`composite: true`). Root
`tsconfig.json` references all buildable packages for `tsc --build`.

### WASM (via Nix)

```sh
nix build .#wasm-plexer    # stable Rust, bundler target
nix build .#wasm-utils     # nightly Rust, web target, wasm-opt
```

### Full Nix Build

```sh
nix build .#ts-packages       # all TS libraries
nix build .#bootstrap-app     # bootstrap server derivation
nix build .#bootstrap-image   # OCI container image (streamLayeredImage)
nix flake check               # all checks including deploy-rs
```

### Dependency Management

```sh
bun install                   # also runs postinstall -> bun2nix -o bun.nix
```

The `bun.nix` lockfile is auto-regenerated on `bun install`. Commit it.

## Testing

```sh
bunx --bun vitest                         # all tests
bunx --bun vitest run packages/ledger     # single package
bunx --bun vitest bench                   # benchmarks
```

Tests live in `src/__tests__/` directories. Benchmarks in `*.bench.ts` files.

## Deployment

```sh
nix run .#deploy                          # deploy to production via deploy-rs
ssh -p 2222 root@decentralizationmaxi.io  # SSH access
```

Production runs NixOS with Podman, systemd-boot (EFI/GPT via disko), SSH on
port 2222 (key-only), fail2ban. Bootstrap server is an OCI container with
Mithril snapshot mounted at `/data`.

### Mithril Snapshot

```sh
nix run .#download-snapshot -- /var/lib/gerolamino/snapshot
```

Downloads latest Mithril snapshot and converts to LMDB format.

## Nix Module Structure

```
flake.nix                          <- inputs, flake-parts, _module.args.root = ./.
nix/default.nix                    <- imports packages/, apps/, machine-configs/
nix/packages/wasm-lib.nix          <- buildWasmPackage shared builder (perSystem arg)
nix/packages/ts-packages.nix       <- bun2nix + tsc --build for all TS packages
nix/packages/bootstrap-image.nix   <- OCI image (streamLayeredImage, 80 layers)
nix/machine-configs/production.nix <- NixOS config + deploy-rs node
```

Key patterns:

- `_module.args.root` provides project root as Nix path (not string)
- `buildWasmPackage` injected as `perSystem._module.args`
- WASM outputs injected into TS source tree via `postUnpack`
- bun2nix flags: `--backend=copyfile`, `dontUseBunBuild`, `dontRunLifecycleScripts`

