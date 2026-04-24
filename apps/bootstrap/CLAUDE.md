# apps/bootstrap

Bootstrap HTTP server. Serves Mithril snapshot data over REST. Uses Effect CLI
framework with Bun runtime and the V2LSM backend (`packages/ffi`) for block
storage.

## Structure

```
src/
  cli.ts              <- Effect CLI entry point (Commands, Flags)
  server.ts           <- HTTP server (Bun.serve) + WS endpoints
  bun-ws-config.ts    <- Bun WebSocket tuning (upstream monkey-patch)
  loader.ts           <- snapshot loading (SnapshotMeta as Schema.Class)
  chunk-reader.ts     <- streaming block chunks from ImmutableDB
  proxy.ts            <- upstream Cardano node proxy
  errors.ts           <- Schema.TaggedErrorClass error types
  __tests__/
    lsm-bootstrap.test.ts     <- V2LSM snapshot bootstrap E2E
    production-client.test.ts <- production-WS integration
    chunk-reader.test.ts      <- chunk parsing
    full-stream-decode.test.ts <- E2E: stream + decode all ~4.5M blocks
```

Previously included `lmdb.ts` / `lmdb-kv.ts` (LMDB integration) + hand-crafted
`openapi.ts` — both removed; `packages/ffi` V2LSM is the sole storage backend
(Mithril distribution 2537.0+ ships V2LSM snapshots natively).

## Dependencies

- `@effect/platform-bun` - Bun runtime layer (`BunRuntime.runMain`, `BunServices.layer`)
- `bootstrap` (workspace) - protocol client
- `codecs` (workspace) - CBOR handling
- `ledger` (workspace) - block decoding
- `effect` ^4.0.0-beta.47

## Key Patterns

- **LSM**: Native V2LSM backend loaded via `LIBLSM_BRIDGE_PATH` (`packages/ffi`)
- **FFI**: Bun FFI for native LSM bridge library (`bun:ffi`)
- **CLI**: `Command.make()` + `Flag.string()` / `Flag.file()` from `effect/unstable/cli`
- **Snapshot**: Dynamic slot discovery from LSM directory listing (not hardcoded)

## Environment variables / CLI flags

| Flag              | Env var              | Default                                          |
| ----------------- | -------------------- | ------------------------------------------------ |
| `--upstream-url`  | `UPSTREAM_URL`       | `tcp://preprod-node.play.dev.cardano.org:3001`   |
| `--network / -n`  | `NETWORK`            | `preprod`                                        |
| `--lsm-lib`       | `LIBLSM_BRIDGE_PATH` | (none — required)                                |
| `--snapshot-path` | (none)               | (optional)                                       |
| `--db-path`       | (none)               | (optional)                                       |
| (none)            | `CORS_ORIGINS`       | `*` (comma-separated allow-list; narrow in prod) |

## Running

Two data-source modes (one required):

- `--snapshot-path` — Mithril V2LSM-converted snapshot directory. Layout:
  `protocolMagicId`, `ledger/<slot>/{state,meta}`, `immutable/*.chunk`, `lsm/`.
- `--db-path` — running cardano-node V2LSM database directory. Layout:
  `ledger/<slot>/{state,meta}`, `immutable/*.chunk`, `lsm/{active,snapshots,metadata,lock}`.
  Needs `--network` explicit (`preprod` default) since there is no
  `protocolMagicId` file. The server hard-links the latest
  `lsm/snapshots/<slot>/` into a temp session dir to avoid contending on the
  running node's `lsm/lock`.

```sh
# Mithril-converted snapshot mode
LIBLSM_BRIDGE_PATH=/nix/store/…-lsm-bridge/lib/liblsm-bridge.so \
  bun run apps/bootstrap/src/cli.ts serve -s /path/to/snapshot -n preprod

# cardano-node db mode (dev default — see README for fixture setup)
LIBLSM_BRIDGE_PATH=/nix/store/…-lsm-bridge/lib/liblsm-bridge.so \
  bun run apps/bootstrap/src/cli.ts serve -d .devenv/state/prod-snapshot -n preprod
```

## Dev fixture

The default dev fixture is `.devenv/state/prod-snapshot/` — a point-in-time
ZFS snapshot rsynced from the production cardano-node at
`178.156.252.81:/data/cardano-node/db`. Upstream Mithril snapshots are served
at cardano-node v10.6.2 (pre-10.7) and can't be LSM-converted client-side
(`tablesCodecVersion` is required from 10.7+); the production box runs
master-track cardano-node with native V2LSM, so the rsync bypasses the
version skew entirely.

Refresh with:

```sh
ssh root@178.156.252.81 'zfs snapshot zroot/data@pipeline-$(date +%s)'
rsync -aP --info=progress2 \
  root@178.156.252.81:/data/.zfs/snapshot/pipeline-<ts>/cardano-node/db/ \
  .devenv/state/prod-snapshot/
ssh root@178.156.252.81 'zfs destroy zroot/data@pipeline-<ts>'
```

## Testing

```sh
bunx --bun vitest run apps/bootstrap
```

The `lsm-bootstrap.test.ts` suite requires one of:

- `SNAPSHOT_PATH` → Mithril-converted V2LSM snapshot, OR
- `NODE_DB_PATH` → cardano-node db (native V2LSM; default dev path is
  `.devenv/state/prod-snapshot`)

plus `LIBLSM_BRIDGE_PATH` (the liblsm-bridge.so). Without both, the suite
is skipped. The "complete stream" test streams the full chain (~6 GB of
CBOR) and is allocated 15 min.

## Deployment

Containerized via `nix build .#bootstrap-image` (OCI image). Runs in Podman
on the production NixOS server. Mithril snapshot mounted as `/data` volume.
Port 3040.
