# apps/tui

Sync-to-tip Cardano data node with embedded `Bun.WebView` dashboard.

## Architecture

Bootstraps from a local Mithril V2LSM snapshot directory
(`--snapshot-path`) or from genesis (`--genesis`), then validates
headers via the consensus layer and stores data locally via the
BlobStore-backed ChainDB + LedgerSnapshotStore. The legacy bootstrap
server (`apps/bootstrap`) has been removed — relay sync over
`BunSocket.layerNet` is the only WS connection in the loop, and the
upstream is a real cardano-node relay (no WS proxy needed for the TUI).

### Visualization

By default the TUI mounts a `Bun.WebView` host on the bundled dashboard
SPA (`packages/dashboard/dist-spa/index.html`) and pushes atom-state
deltas into the webview every 16ms via `view.evaluate(window.__APPLY_DELTAS__(...))`.

Pass `--headless` to skip the WebView and run the node as a pure Effect
program — the same atom state is dumped via structured `Effect.log` lines
on a 10-second cadence (annotations: `status`, `gsm`, `tipSlot`, `currentSlot`,
`epoch`, `syncPct`, `blocks`, `peers`, `events`, `bootstrap`).

`Bun.WebView` is **single-in-flight per view** (Bun source:
`JSWebViewPrototype.cpp:242`); the delta-push fiber serializes calls
inherently by waiting for each `evaluate()` promise before scheduling
the next.

## Dependencies

- `@effect/platform-bun` — Bun runtime layer
- `consensus` (workspace) — header validation, slot clock, peer manager,
  `ChainEventStream`, `ConsensusEvents`
- `dashboard` (workspace) — atoms + `createDomPrimitives` + `<Dashboard>`
- `ledger` (workspace) — block + ext-ledger-state decode
- `storage` (workspace) — ChainDB, LedgerSnapshotStore, BlobStore
- `lsm-ffi` (workspace) — LSM BlobStore backend (Zig → Haskell V2LSM)
- `effect` ^4.0.0-beta.47+

## Environment variables / CLI flags

| Flag                 | Env var                  | Default                             |
| -------------------- | ------------------------ | ----------------------------------- |
| `--genesis / -g`     | (none)                   | `false`                             |
| `--relay-host`       | `RELAY_HOST`             | `preprod-node.play.dev.cardano.org` |
| `--relay-port`       | `RELAY_PORT`             | `3001`                              |
| `--network`          | (none)                   | `preprod`                           |
| `--headless`         | (none)                   | `false` (WebView mounts by default) |
| `--data-dir`         | `GEROLAMINO_DATA_DIR`    | fresh temp dir per run              |
| `--snapshot-path`    | `GEROLAMINO_SNAPSHOT_PATH` | empty (no local snapshot)        |
| (none)               | `LIBLSM_BRIDGE_PATH`     | required for default Zig backend    |
| (none)               | `GEROLAMINO_USE_WASM_LSM`| `0` (Zig backend); `1` opts in to WASM |
| (none)               | `WASM_LSM_MODULE_PATH`   | required when `USE_WASM_LSM=1`      |
| (none)               | `WASM_LSM_JSFFI_PATH`    | required when `USE_WASM_LSM=1`      |

### Local-snapshot bootstrap (`--snapshot-path`)

When set, the LSM session opens against `<snapshot-path>/lsm/`
(canonical Mithril V2LSM layout); relay sync resumes from whatever
tip the snapshot encodes.

Today this still seeds the consensus `LedgerView` from genesis (same as
`--genesis`); a follow-up reads `<snapshot-path>/protocolMagicId` +
`<snapshot-path>/ledger/{slot}/state` (CBOR `ExtLedgerState`) to
seed the post-snapshot ledger state directly. Without that follow-up,
`--snapshot-path` doesn't shave catch-up time vs `--genesis` —
consensus still has to evolve nonces + populate the stake distribution
over the relay protocol. The LSM session having the snapshot's UTxO
set IS already a win for ChainDB / LedgerSnapshotStore queries — those
resolve against the on-disk snapshot immediately.

Use this together with `GEROLAMINO_USE_WASM_LSM=1` once Bun's
`node:wasi` reactor fix lands.

### LSM backend (Zig vs WASM)

Default: bun:ffi → `liblsm-bridge.so` → Haskell V2LSM (the `LIBLSM_BRIDGE_PATH`
chain).

Opt-in: WASM lsm-tree via Bun's `node:wasi` + the in-tree reactor polyfill
(`packages/ffi/src/lsm-wasm/bun-wasi.ts`). Set:

```sh
GEROLAMINO_USE_WASM_LSM=1 \
WASM_LSM_MODULE_PATH=$PWD/packages/ffi/haskell/lsm-tree-wasm-shim/lsm-tree-wasm.wasm \
WASM_LSM_JSFFI_PATH=$PWD/packages/ffi/haskell/lsm-tree-wasm-shim/lsm-tree-wasm.js \
bun run apps/tui/src/index.ts start --headless
```

**Known limitation (May 2026):** Bun's `node:wasi` reactor pattern has a
multi-call out-of-bounds memory-access bug; the WASM path works for
read-heavy / smoke tests but is unstable under heavy mutation. Track Bun PR
`claude/fix-wasi-initialize-12755`; once merged, the WASM backend becomes
the default and the Zig bridge is removed.

## Running

Build the dashboard SPA bundle first (only needed when not running
`--headless`). The Tailwind v4 step needs a working C++ stdlib in
`LD_LIBRARY_PATH` — easiest is `nix develop` first:

```sh
nix develop
bun packages/dashboard/build.ts
```

Then start the node:

```sh
# Default: mounts Bun.WebView on the bundled dashboard
LIBLSM_BRIDGE_PATH=/path/to/liblsm-bridge.so bun run apps/tui/src/index.ts start

# Headless: log-only, no WebView
LIBLSM_BRIDGE_PATH=/path/to/liblsm-bridge.so bun run apps/tui/src/index.ts start --headless

# Persistent storage for crash-recovery / E2E
bun run apps/tui/src/index.ts start --data-dir ./data/preprod --headless
```

## Testing

```sh
bunx --bun vitest run apps/tui
```

The headless flag is the canonical E2E test path — `Effect.log*`
annotations make the dashboard state machine-parseable from CI logs.
The Bun.WebView path is currently exercised manually (no automated UI
test harness yet).
