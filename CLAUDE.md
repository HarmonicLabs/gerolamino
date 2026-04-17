# Gerolamino

In-browser Cardano node. Bun workspaces monorepo with Effect-TS, Rust/WASM
crypto, and Nix-based build/deploy pipeline.

## Architecture

```
packages/codecs     <- CBOR encoding/decoding (foundation, no internal deps)
packages/ledger          <- Cardano ledger model (depends: codecs, wasm-utils)
packages/miniprotocols   <- Ouroboros network protocols (depends: codecs, wasm-plexer)
packages/storage         <- Storage abstraction with XState machines (depends: effect, xstate)
packages/bootstrap       <- Bootstrap protocol client (depends: effect)
packages/wasm-plexer     <- Multiplexer WASM (Rust, bindgen target: bundler)
packages/wasm-utils      <- Crypto primitives WASM (Rust nightly, bindgen target: web)
packages/chrome-ext      <- Chrome extension (Solid.js + WXT)
packages/consensus       <- Ouroboros Praos consensus (depends: ledger, codecs, storage)
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

### ES2025 / `@typescript/native-preview`

The base `tsconfig.base.json` targets `es2024` (`lib: ["es2024"]`) as the
monorepo-wide baseline. Packages may opt into `target: esnext` / `lib:
["esnext"]` individually for ES2025 access — `packages/codecs` is the first
to do so (see `packages/codecs/tsconfig.json`). We will gradually refactor the
rest of the codebase to match.

Prefer native ES primitives over hand-rolled alternatives:

- `DataView.prototype.getFloat16` / `setFloat16` for IEEE 754 binary16 I/O
  (CBOR §4.2, MemPack half-precision floats) — never hand-roll float16 via
  float32 bit manipulation.
- `Array.from({ length: N }, mapper)` instead of `new Array(N)` + for-loop
  fill when building arrays declaratively.
- `Array.prototype.toSorted` / `.toReversed` / `.toSpliced` / `.with()` when
  immutability matters; `.sort()` etc. only when in-place mutation is
  intended.
- `Iterator.from(iterable)` + `.map/.filter/.take/.toArray()` for lazy
  pipelines where the source is already an iterable.
- `Set.prototype.intersection/union/difference/isSubsetOf/isSupersetOf/
isDisjointFrom` for set algebra (useful for CBOR canonical-form map key
  uniqueness, stake distribution overlap, etc.).
- `Promise.try()` at sync/async boundaries.
- `Error`'s `cause` field (`new Error("...", { cause: inner })`) when
  wrapping an inner error — do not stringify + discard the original.
- Bigint bit-arithmetic (`>>`, `<<`, `&`) for binary-integer work instead of
  hex-string round-trips.
- `String.prototype.isWellFormed` / `.toWellFormed` to validate UTF-16 before
  emitting UTF-8 bytes — `TextEncoder` silently substitutes U+FFFD for
  unpaired surrogates, which corrupts binary-codec payloads.
- `new ArrayBuffer(len, { maxByteLength: N })` + `buffer.resize(N)` for
  growable byte storage instead of copy-to-larger-array loops. Associated
  `DataView` / `Uint8Array` views are length-tracking and see the new length
  automatically.
- `ArrayBuffer.prototype.transfer` / `.transferToFixedLength(N)` for
  zero-copy handoff from a growable buffer to a fixed-size result.

`@typescript/native-preview` (aka `tsgo`) is installed as a devDependency in
`packages/codecs`. It's the native Go rewrite of the TS compiler and
understands `target: esnext` fully. Stock `tsc` (5.9) + `lib: ["esnext"]`
also works for codecs today; tsgo is available for future use when its
config validation stabilizes (currently rejects `baseUrl`).

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
