# apps/tui

Sync-to-tip Cardano data node with embedded `Bun.WebView` dashboard.

## Architecture

Bootstraps remotely from a bootstrap server via WebSocket
(`packages/bootstrap` client), then validates headers via consensus layer
and stores data locally via BlobStore (LSM) + SQLite (ChainDB).

No local `cardano-node` or Mithril snapshot required — the bootstrap server
provides ledger state, UTxO entries, and block data over the wire.

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
- `bootstrap` (workspace) — WebSocket bootstrap client + protocol
- `consensus` (workspace) — header validation, slot clock, peer manager,
  `ChainEventStream`, `ConsensusEvents`
- `dashboard` (workspace) — atoms + `createDomPrimitives` + `<Dashboard>`
- `ledger` (workspace) — block + ext-ledger-state decode
- `storage` (workspace) — ChainDB, LedgerSnapshotStore, BlobStore
- `lsm-ffi` (workspace) — LSM BlobStore backend (Zig → Haskell V2LSM)
- `effect` ^4.0.0-beta.47+

## Environment variables / CLI flags

| Flag                 | Env var                | Default                             |
| -------------------- | ---------------------- | ----------------------------------- |
| `--bootstrap-url/-b` | `BOOTSTRAP_SERVER_URL` | `ws://localhost:3040/bootstrap`     |
| `--genesis / -g`     | (none)                 | `false`                             |
| `--relay-host`       | `RELAY_HOST`           | `preprod-node.play.dev.cardano.org` |
| `--relay-port`       | `RELAY_PORT`           | `3001`                              |
| `--network`          | (none)                 | `preprod`                           |
| `--headless`         | (none)                 | `false` (WebView mounts by default) |
| `--data-dir`         | `GEROLAMINO_DATA_DIR`  | fresh temp dir per run              |

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
