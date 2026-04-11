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
- `lsm-tree` (workspace) - LSM BlobStore backend
- `effect` ^4.0.0-beta.43

## CLI Flags

- `--bootstrap-url / -b` — Bootstrap server WebSocket URL (default: ws://178.156.252.81:3040/bootstrap)
- `--relay-host` — Upstream relay host for ChainSync
- `--relay-port` — Upstream relay port
- `--network` — Cardano network (preprod|mainnet)

## Running

```sh
LIBLSM_BRIDGE_PATH=/path/to/liblsm-bridge.so bun run apps/tui/src/index.ts start
```

## Testing

```sh
bunx --bun vitest run apps/tui
```
