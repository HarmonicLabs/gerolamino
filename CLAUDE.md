# Gerolamino

In-browser Cardano node. Nx monorepo with Bun runtime, Effect-TS, Rust/WASM
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
packages/consensus       <- (placeholder)
packages/dashboard       <- (placeholder)
apps/bootstrap           <- Bootstrap HTTP server (Effect CLI + Bun + LMDB)
apps/tui                 <- Terminal UI (stub)
```

## Tech Stack

- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript 5.9+, Rust (WASM targets)
- **Monorepo**: Nx 22.6 with @nx/js/typescript plugin
- **Effects**: Effect ^4.0.0-beta.43 (all packages)
- **State machines**: XState ^5.30 (storage, miniprotocols, chrome-ext)
- **Testing**: `bunx --bun vitest` (Bun v1.3.11+ required)
- **Nix**: flake-parts + bun2nix + crane + deploy-rs
- **CI**: GitHub Actions with Arch Linux + Determinate Nix container
- **Deploy**: deploy-rs to `decentralizationmaxi.io` (NixOS, Podman)

## Coding Conventions

- **Never use `as Type`** typecasts. Only `as const` is allowed. Use
  Effect pipelines and Schema for type safety.
- **Use `Schema.TaggedClass`** (not branded types) for domain types that need
  methods. Use `Schema.TaggedErrorClass` for error types.
- **Use `Effect.gen` with `yield*`**, not nested `Effect.flatMap` chains.
- **Use `Config.string()`** for environment variables, not `process.env`.
- **All imports at top of file** - no dynamic `import()` inside functions.
- **No lodash** - use native Array methods (`Array.from`, `for` loops, etc.).
- Cross-package imports use `tsconfig.base.json` path aliases (e.g.,
  `import { ... } from "ledger/lib/block/block.ts"`).

## Building

### TypeScript (via Nx)

```sh
bunx nx run-many --target=build --projects=cbor-schema,ledger,miniprotocols,storage
bunx nx build <package>            # single package
bunx nx affected --target=build    # only changed
```

Nx discovers build targets from `tsconfig.lib.json` files (`composite: true`,
`skipBuildCheck: true` in nx.json because package.json main points to source).

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
nix/packages/ts-packages.nix       <- bun2nix + Nx build for all TS packages
nix/packages/bootstrap-image.nix   <- OCI image (streamLayeredImage, 80 layers)
nix/machine-configs/production.nix <- NixOS config + deploy-rs node
```

Key patterns:

- `_module.args.root` provides project root as Nix path (not string)
- `buildWasmPackage` injected as `perSystem._module.args`
- WASM outputs injected into TS source tree via `postUnpack`
- bun2nix flags: `--backend=copyfile`, `dontUseBunBuild`, `dontRunLifecycleScripts`

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## Nx Guidelines

- For navigating/exploring the workspace, invoke the `nx-workspace` skill
  first - it has patterns for querying projects, targets, and dependencies
- When running tasks (build, lint, test, e2e, etc.), always prefer
  `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) over underlying tooling
- Prefix nx commands with `bunx` (e.g., `bunx nx build`, `bunx nx test`)
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`
- NEVER guess CLI flags - always check nx_docs or `--help` first

### Scaffolding & Generators

- For scaffolding tasks, ALWAYS invoke the `nx-generate` skill FIRST

### When to use nx_docs

- USE for: advanced config, unfamiliar flags, migration guides, edge cases
- DON'T USE for: basic generator syntax, standard commands
- The `nx-generate` skill handles generator discovery internally

<!-- nx configuration end-->
