# apps/tui

Terminal UI application — sync-to-tip Cardano data node.

## Architecture

Bootstraps remotely from a bootstrap server via WebSocket (packages/bootstrap
client), then validates headers via consensus layer, stores data locally via
BlobStore (LSM) + SQLite (ChainDB).

No local cardano-node or Mithril snapshot required — the bootstrap server
provides ledger state, UTxO entries, and block data over the wire.

## Dependencies

- `@effect/platform-bun` - Bun runtime layer
- `bootstrap` (workspace) - WebSocket bootstrap client + protocol
- `consensus` (workspace) - Header validation, slot clock, peer management
- `ledger` (workspace) - Block/state decoding
- `storage` (workspace) - ChainDB, SqliteDrizzle, BlobStore
- `ffi` (workspace) - LSM BlobStore backend (Zig → Haskell V2LSM FFI)
- `effect` ^4.0.0-beta.47

## Environment variables / CLI flags

| Flag                 | Env var                | Default                             |
| -------------------- | ---------------------- | ----------------------------------- |
| `--bootstrap-url/-b` | `BOOTSTRAP_SERVER_URL` | `ws://localhost:3040/bootstrap`     |
| `--genesis / -g`     | (none)                 | `false`                             |
| `--relay-host`       | `RELAY_HOST`           | `preprod-node.play.dev.cardano.org` |
| `--relay-port`       | `RELAY_PORT`           | `3001`                              |
| `--network`          | (none)                 | `preprod`                           |

## Running

```sh
LIBLSM_BRIDGE_PATH=/path/to/liblsm-bridge.so bun run apps/tui/src/index.ts start
```

## Testing

```sh
bunx --bun vitest run apps/tui
```
